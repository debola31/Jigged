import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/__tests__/test-utils';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import VideoRecorderDialog from '@/components/operator/VideoRecorderDialog';

/**
 * jsdom has neither `MediaRecorder` nor `getUserMedia`, so everything here runs on
 * fakes. The fakes are DRIVEABLE rather than inert — a test can push a chunk in and
 * end a recording — because the properties worth protecting are all about timing and
 * teardown, and an inert stub would let every one of them regress silently.
 *
 * What is deliberately NOT tested here: which container gets chosen, and whether the
 * control is offered at all. Those are pure decisions and live in
 * __tests__/lib/videoCapture.test.ts, where they can be asserted without a camera.
 */

class FakeTrack {
  stop = vi.fn();
}

class FakeStream {
  tracks = [new FakeTrack(), new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);

  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onstart: (() => void) | null = null;
  onerror: (() => void) | null = null;
  stopCalls = 0;

  constructor(
    public stream: unknown,
    public options: Record<string, unknown>,
  ) {
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
    this.onstart?.();
  }

  stop() {
    this.stopCalls += 1;
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.onstop?.();
  }

  /** Push one second's worth of bytes, the way a timeslice recording does. */
  emit(bytes = 1024) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) });
  }
}

const latest = () => FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1];

let getUserMedia: ReturnType<typeof vi.fn>;
let clock = 0;

function setup(overrides: { onCaptured?: () => void; onClose?: () => void } = {}) {
  const onCaptured = vi.fn(overrides.onCaptured);
  const onClose = vi.fn(overrides.onClose);
  const view = render(
    <VideoRecorderDialog open onClose={onClose} onCaptured={onCaptured} />,
  );
  return { onCaptured, onClose, view };
}

/** Get to a live recording with one chunk banked. */
async function startRecording(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByLabelText('Start recording');
  await user.click(screen.getByLabelText('Start recording'));
  act(() => latest().emit());
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  clock = 0;
  getUserMedia = vi.fn(async () => new FakeStream());

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  // jsdom implements neither, and both are on the happy path.
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    writable: true,
    value: null,
  });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('VideoRecorderDialog — opening the camera', () => {
  it('asks for the rear camera and for audio', async () => {
    setup();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    const constraints = getUserMedia.mock.calls[0][0] as MediaStreamConstraints;
    expect((constraints.video as MediaTrackConstraints).facingMode).toEqual({
      ideal: 'environment',
    });
    expect(constraints.audio).toBeTruthy();
  });

  it('says the cap out loud before anything is recorded', async () => {
    setup();
    expect(await screen.findByText(/Up to 2:00/)).toBeInTheDocument();
  });

  it('explains a blocked permission and offers no way to record', async () => {
    const denied = new Error('nope');
    denied.name = 'NotAllowedError';
    getUserMedia.mockRejectedValue(denied);
    setup();

    expect(await screen.findByText(/blocked/i)).toBeInTheDocument();
    // The fix is in browser settings, so there is nothing a retry could do here.
    expect(screen.queryByLabelText('Start recording')).toBeNull();
  });

  it('distinguishes a camera another app is holding', async () => {
    const busy = new Error('busy');
    busy.name = 'NotReadableError';
    getUserMedia.mockRejectedValue(busy);
    setup();

    expect(await screen.findByText(/in use by another app/i)).toBeInTheDocument();
  });
});

describe('VideoRecorderDialog — the two-minute cap', () => {
  it('stops itself at 2:00 and reports the duration it measured', async () => {
    // `toFake` deliberately excludes `performance`: the component measures the clip
    // with `performance.now()`, and letting the fake timers own that too would take
    // the clock away from the test that is trying to drive it.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onCaptured } = setup();

    await startRecording(user);

    // The clock starts at `onstart`, not at the tap — permission plumbing and
    // pipeline warm-up are real milliseconds and are not part of the clip.
    act(() => {
      clock = 120_000;
      vi.advanceTimersByTime(400);
    });

    await waitFor(() => expect(onCaptured).toHaveBeenCalled());
    expect(onCaptured.mock.calls[0][0]).toMatchObject({ durationSeconds: 120 });
  });

  it('hands back exactly one clip even when several things ask it to stop', async () => {
    // `toFake` deliberately excludes `performance`: the component measures the clip
    // with `performance.now()`, and letting the fake timers own that too would take
    // the clock away from the test that is trying to drive it.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onCaptured } = setup();

    await startRecording(user);

    await user.click(screen.getByLabelText('Stop recording'));
    act(() => {
      clock = 130_000;
      vi.advanceTimersByTime(1000);
    });

    // The auto-stop, the button and a backgrounded tab all reach the same path.
    // Firing twice would post the clip twice.
    expect(onCaptured).toHaveBeenCalledTimes(1);
  });

  it('names the file for the container it actually wrote', async () => {
    const user = userEvent.setup();
    const { onCaptured } = setup();

    await startRecording(user);
    await user.click(screen.getByLabelText('Stop recording'));

    await waitFor(() => expect(onCaptured).toHaveBeenCalled());
    const file = onCaptured.mock.calls[0][0].file as File;
    expect(file.name).toBe('clip.mp4');
    // The BASE type, not the codecs string: Supabase derives Content-Type from
    // this, and Safari will not play a clip served as something it cannot name.
    expect(file.type).toBe('video/mp4');
  });
});

describe('VideoRecorderDialog — letting the camera go', () => {
  it('stops every track on unmount', async () => {
    const { view } = setup();
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    const stream = (await getUserMedia.mock.results[0].value) as FakeStream;

    view.unmount();

    // A held camera is a visible, battery-burning bug, and on iOS a stream that
    // outlives its page is how the NEXT recording fails with NotReadableError.
    stream.tracks.forEach((t) => expect(t.stop).toHaveBeenCalled());
  });

  it('stops every track after a normal stop', async () => {
    const user = userEvent.setup();
    setup();
    const stream = (await getUserMedia.mock.results[0]?.value) as FakeStream;

    await startRecording(user);
    await user.click(screen.getByLabelText('Stop recording'));

    await waitFor(() => stream.tracks.forEach((t) => expect(t.stop).toHaveBeenCalled()));
  });

  it('keeps what was recorded when the tab is backgrounded', async () => {
    const user = userEvent.setup();
    const { onCaptured } = setup();

    await startRecording(user);
    act(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // iOS suspends a backgrounded capture pipeline, so continuing would produce a
    // truncated or empty container. A short clip beats a corrupt one.
    await waitFor(() => expect(onCaptured).toHaveBeenCalledTimes(1));
  });

  it('reports a recording that came back empty instead of posting nothing', async () => {
    const user = userEvent.setup();
    const { onCaptured } = setup();

    await screen.findByLabelText('Start recording');
    await user.click(screen.getByLabelText('Start recording'));
    // No chunk emitted — a real recorder does this when the phone is out of storage.
    await user.click(screen.getByLabelText('Stop recording'));

    expect(await screen.findByText(/came back empty/i)).toBeInTheDocument();
    expect(onCaptured).not.toHaveBeenCalled();
  });
});
