"""
JARVIS Gesture Service - Phase 1
Real-time hand tracking + gesture recognition from a plain webcam.

A gesture is just another way to emit an intent. This service watches the
webcam and (once Phase 3 is enabled) POSTs to the SAME /command endpoint your
voice service already hits. Gesture and voice collapse into one problem.

Setup:
    pip install mediapipe opencv-python

Run:
    python gesture_service.py

Press 'q' in the window to quit.
"""

import math
import time
from collections import deque, Counter

import cv2
import mediapipe as mp

# ----------------------------------------------------------------------------
# Tuning constants  <-- this is what you fiddle with in Phase 2
# ----------------------------------------------------------------------------
CAM_INDEX        = 0      # change if you have multiple cameras
THUMB_THRESH     = 0.50   # thumb counts as extended if tip-to-index-MCP > this * hand_scale
PINCH_THRESH     = 0.35   # pinch if thumb-tip-to-index-tip < this * hand_scale
STABILITY_FRAMES = 5      # gesture must hold this many frames to count as stable
STABILITY_MIN    = 4      # ...and be the majority at least this many of those frames
EVENT_COOLDOWN   = 0.8    # seconds before the same gesture can fire again

# Only these gestures fire an action. POINT is the "cursor" pose and stays silent.
GESTURE_COMMANDS = {
    "FIST":      "lights off",
    "OPEN_PALM": "lights on",
    "PINCH":     "select",
    "PEACE":     "next track",
}

# ----------------------------------------------------------------------------
# One-euro filter  (raw landmarks jitter hard; this is the standard low-latency
# smoother for exactly this job)
# ----------------------------------------------------------------------------
def _alpha(t_e, cutoff):
    r = 2 * math.pi * cutoff * t_e
    return r / (r + 1.0)


class OneEuroFilter:
    def __init__(self, min_cutoff=1.0, beta=0.007, d_cutoff=1.0):
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self.x_prev = None
        self.dx_prev = 0.0
        self.t_prev = None

    def __call__(self, x, t):
        if self.x_prev is None:
            self.x_prev, self.t_prev = x, t
            return x
        t_e = t - self.t_prev
        if t_e <= 0:
            return self.x_prev
        dx = (x - self.x_prev) / t_e
        dx_hat = _alpha(t_e, self.d_cutoff) * dx + (1 - _alpha(t_e, self.d_cutoff)) * self.dx_prev
        cutoff = self.min_cutoff + self.beta * abs(dx_hat)
        a = _alpha(t_e, cutoff)
        x_hat = a * x + (1 - a) * self.x_prev
        self.x_prev, self.dx_prev, self.t_prev = x_hat, dx_hat, t
        return x_hat


class LandmarkSmoother:
    """One filter per (landmark index, axis). Smooths the primary hand only."""
    def __init__(self):
        self.filters = {}

    def smooth(self, landmarks, t):
        out = []
        for i, (x, y) in enumerate(landmarks):
            fx = self.filters.setdefault((i, "x"), OneEuroFilter())
            fy = self.filters.setdefault((i, "y"), OneEuroFilter())
            out.append((fx(x, t), fy(y, t)))
        return out


# ----------------------------------------------------------------------------
# Gesture classification
# ----------------------------------------------------------------------------
# MediaPipe Hands landmark indices
WRIST = 0
THUMB_TIP, THUMB_MCP = 4, 2
INDEX_MCP, INDEX_PIP, INDEX_TIP = 5, 6, 8
MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP = 9, 10, 12
RING_PIP, RING_TIP = 14, 16
PINKY_PIP, PINKY_TIP = 18, 20


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def classify(lm):
    """lm: list of (x, y) normalized points. Returns a gesture label string."""
    scale = _dist(lm[WRIST], lm[MIDDLE_MCP]) or 1e-6  # palm length, for scale-invariance

    # A finger is "extended" if its tip sits higher (smaller y) than its PIP joint.
    idx_ext   = lm[INDEX_TIP][1]  < lm[INDEX_PIP][1]
    mid_ext   = lm[MIDDLE_TIP][1] < lm[MIDDLE_PIP][1]
    ring_ext  = lm[RING_TIP][1]   < lm[RING_PIP][1]
    pinky_ext = lm[PINKY_TIP][1]  < lm[PINKY_PIP][1]
    thumb_ext = _dist(lm[THUMB_TIP], lm[INDEX_MCP]) > THUMB_THRESH * scale

    fingers = [idx_ext, mid_ext, ring_ext, pinky_ext]
    n = sum(fingers)
    pinch = _dist(lm[THUMB_TIP], lm[INDEX_TIP]) / scale < PINCH_THRESH

    if pinch and n >= 1:                       # checked first; n>=1 keeps it off the fist
        return "PINCH"
    if thumb_ext and n == 4:
        return "OPEN_PALM"
    if n == 0 and not thumb_ext:
        return "FIST"
    if fingers == [True, False, False, False]:
        return "POINT"
    if fingers == [True, True, False, False]:
        return "PEACE"
    return "NEUTRAL"


# ----------------------------------------------------------------------------
# Intent dispatch  (Phase 3: uncomment the POST block)
# ----------------------------------------------------------------------------
ORCH_URL = "http://localhost:3000/command"  # wherever your orchestrator listens

def send_intent(command_text):
    print(f"  -> intent: {command_text!r}")
    # --- Phase 3: this is the whole integration. ---
    # import requests
    # try:
    #     requests.post(ORCH_URL, json={"text": command_text, "source": "gesture"}, timeout=1.5)
    # except Exception as e:
    #     print(f"  !! orchestrator unreachable: {e}")


# ----------------------------------------------------------------------------
# Main loop
# ----------------------------------------------------------------------------
def main():
    mp_hands = mp.solutions.hands
    mp_draw = mp.solutions.drawing_utils
    mp_styles = mp.solutions.drawing_styles

    cap = cv2.VideoCapture(CAM_INDEX)
    if not cap.isOpened():
        raise SystemExit(f"Could not open camera {CAM_INDEX}. Try a different CAM_INDEX.")

    smoother = LandmarkSmoother()
    recent = deque(maxlen=STABILITY_FRAMES)
    stable_label = "NEUTRAL"
    last_fire_t = 0.0
    last_event = "-"
    prev_t = time.time()
    fps = 0.0

    with mp_hands.Hands(
        model_complexity=0,            # 0 = fastest, lowest latency on CPU
        max_num_hands=2,
        min_detection_confidence=0.6,
        min_tracking_confidence=0.5,
    ) as hands:
        while True:
            ok, frame = cap.read()
            if not ok:
                break

            frame = cv2.flip(frame, 1)              # natural mirror
            h, w = frame.shape[:2]
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            rgb.flags.writeable = False
            results = hands.process(rgb)

            now = time.time()
            label = "NEUTRAL"

            if results.multi_hand_landmarks:
                # draw every detected hand's skeleton
                for hand_lms in results.multi_hand_landmarks:
                    mp_draw.draw_landmarks(
                        frame, hand_lms, mp_hands.HAND_CONNECTIONS,
                        mp_styles.get_default_hand_landmarks_style(),
                        mp_styles.get_default_hand_connections_style(),
                    )

                # primary hand = first detected; smooth it and classify
                primary = results.multi_hand_landmarks[0]
                raw = [(p.x, p.y) for p in primary.landmark]
                sm = smoother.smooth(raw, now)
                label = classify(sm)

                # cursor dot on the smoothed index tip (previews the HUD cursor)
                cx, cy = int(sm[INDEX_TIP][0] * w), int(sm[INDEX_TIP][1] * h)
                cv2.circle(frame, (cx, cy), 10, (255, 200, 0), -1)
                cv2.circle(frame, (cx, cy), 14, (255, 255, 255), 1)

            # --- stability + edge-triggered firing ---
            recent.append(label)
            top, count = Counter(recent).most_common(1)[0]
            if len(recent) == STABILITY_FRAMES and count >= STABILITY_MIN:
                if top != stable_label:
                    stable_label = top
                    if top in GESTURE_COMMANDS and (now - last_fire_t) > EVENT_COOLDOWN:
                        last_fire_t = now
                        last_event = f"{top} @ {time.strftime('%H:%M:%S')}"
                        print(f"[event] {top}")
                        send_intent(GESTURE_COMMANDS[top])

            # --- HUD overlay ---
            fps = 0.9 * fps + 0.1 * (1.0 / max(now - prev_t, 1e-6))
            prev_t = now
            color = (0, 255, 120) if stable_label in GESTURE_COMMANDS else (200, 200, 200)
            cv2.putText(frame, stable_label, (20, 60),
                        cv2.FONT_HERSHEY_SIMPLEX, 1.6, color, 3)
            cv2.putText(frame, f"fps {fps:4.1f}", (20, h - 50),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (180, 180, 180), 1)
            cv2.putText(frame, f"last event: {last_event}", (20, h - 22),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (180, 180, 180), 1)

            cv2.imshow("JARVIS Gesture Service", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

    cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
