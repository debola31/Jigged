import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor } from '@/__tests__/test-utils';

vi.mock('posthog-js', () => ({ default: { capture: vi.fn() } }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const createPilotRequest = vi.fn();
const uploadPilotFile = vi.fn();
const completePilotRequest = vi.fn();
vi.mock('@/lib/pilotRequestClient', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/pilotRequestClient')>()),
  createPilotRequest: (...args: unknown[]) => createPilotRequest(...args),
  uploadPilotFile: (...args: unknown[]) => uploadPilotFile(...args),
  completePilotRequest: (...args: unknown[]) => completePilotRequest(...args),
}));

import posthog from 'posthog-js';
import * as Sentry from '@sentry/nextjs';
import { PilotRequestError } from '@/lib/pilotRequestClient';
import PilotRequest from '@/app/(marketing)/showcase/_components/PilotRequest';

const ID = '3f1c2b9e-8d7a-4c6b-9e5f-1a2b3c4d5e6f';
const UPLOAD = { url: 'https://example.supabase.co/storage/v1/object/upload/sign/x?token=t', content_type: 'application/octet-stream' };

function chooseFile(container: HTMLElement, name = 'bracket.step', size = 2048) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array(size)], name);
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  createPilotRequest.mockResolvedValue({ request_id: ID, upload: UPLOAD });
  uploadPilotFile.mockImplementation(async (_u: unknown, _f: unknown, onProgress: (n: number) => void) => {
    onProgress(1);
  });
  completePilotRequest.mockResolvedValue(undefined);
});

describe('PilotRequest — idle', () => {
  it('says what is missing instead of leaving a dead button', () => {
    render(<PilotRequest />);
    expect(screen.getByRole('button', { name: 'Send my part' })).toBeDisabled();
    // MissingFieldsNotice bullets each item.
    expect(screen.getByText(/Choose your part file/)).toBeInTheDocument();
    expect(screen.getByText(/Enter your email address/)).toBeInTheDocument();
  });

  it('makes the three promises in plain words', () => {
    render(<PilotRequest />);
    expect(screen.getByText(/Only the Jigged team opens your file/)).toHaveTextContent(
      /use it only to make your walkthrough, and we delete it whenever you ask/,
    );
  });

  it('refuses a format it cannot take, at the field', () => {
    const { container } = render(<PilotRequest />);
    chooseFile(container, 'model.stl');
    expect(screen.getByText(/model\.stl/)).toHaveTextContent(/Choose a STEP, IGES, Parasolid/);
    expect(screen.getByRole('button', { name: 'Send my part' })).toBeDisabled();
  });
});

describe('PilotRequest — sending', () => {
  it('creates, uploads and confirms, then thanks the visitor and records only the shape', async () => {
    const user = userEvent.setup();
    const { container } = render(<PilotRequest />);
    const file = chooseFile(container);
    await user.type(screen.getByLabelText(/Email/), 'owner@shop.example');
    await user.type(screen.getByLabelText(/Note/), 'Qty 40');
    await user.click(screen.getByRole('button', { name: 'Send my part' }));

    expect(await screen.findByText(/your part is with us/)).toBeInTheDocument();
    expect(screen.getByText(/be in touch at/)).toHaveTextContent('owner@shop.example');

    expect(createPilotRequest).toHaveBeenCalledWith({
      email: 'owner@shop.example',
      name: null,
      company_name: null,
      note: 'Qty 40',
      file_name: 'bracket.step',
      file_size: 2048,
      website: '',
    });
    expect(uploadPilotFile).toHaveBeenCalledWith(UPLOAD, file, expect.any(Function));
    expect(completePilotRequest).toHaveBeenCalledWith(ID);

    expect(posthog.capture).toHaveBeenCalledTimes(1);
    expect(posthog.capture).toHaveBeenCalledWith('pilot request submitted', {
      file_type: 'step',
      has_name: false,
      has_company: false,
      has_note: true,
    });
    expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain('owner@shop.example');
    expect(JSON.stringify(vi.mocked(posthog.capture).mock.calls)).not.toContain('Qty 40');
  });

  it('shows upload progress while the file is moving', async () => {
    let release: () => void = () => {};
    uploadPilotFile.mockImplementation(
      (_u: unknown, _f: unknown, onProgress: (n: number) => void) =>
        new Promise<void>((resolve) => {
          onProgress(0.42);
          release = resolve;
        }),
    );
    const user = userEvent.setup();
    const { container } = render(<PilotRequest />);
    chooseFile(container);
    await user.type(screen.getByLabelText(/Email/), 'owner@shop.example');
    await user.click(screen.getByRole('button', { name: 'Send my part' }));

    expect(await screen.findByRole('button', { name: /Uploading 42%/ })).toBeDisabled();
    expect(screen.getByRole('progressbar', { name: 'Upload progress' })).toHaveAttribute('aria-valuenow', '42');
    release();
    expect(await screen.findByText(/your part is with us/)).toBeInTheDocument();
  });

  it('on a dropped connection, retries the SAME upload rather than making a second request', async () => {
    uploadPilotFile.mockRejectedValueOnce(
      new PilotRequestError("We couldn't reach Jigged. Check your connection and try again.", 'upload', 0),
    );
    const user = userEvent.setup();
    const { container } = render(<PilotRequest />);
    chooseFile(container);
    await user.type(screen.getByLabelText(/Email/), 'owner@shop.example');
    await user.click(screen.getByRole('button', { name: 'Send my part' }));

    expect(await screen.findByText(/couldn't reach Jigged/)).toBeInTheDocument();
    // The visitor's network is not a bug.
    expect(Sentry.captureException).not.toHaveBeenCalled();
    // And the indicator cleared, so retry is possible.
    expect(screen.getByRole('button', { name: 'Send my part' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/your part is with us/)).toBeInTheDocument();
    expect(createPilotRequest).toHaveBeenCalledTimes(1);
    expect(uploadPilotFile).toHaveBeenCalledTimes(2);
    expect(completePilotRequest).toHaveBeenCalledTimes(1);
  });

  it('reports a server failure to Sentry and shows the message', async () => {
    completePilotRequest.mockRejectedValueOnce(
      new PilotRequestError('Something went wrong sending your part. Please try again.', 'complete', 500),
    );
    const user = userEvent.setup();
    const { container } = render(<PilotRequest />);
    chooseFile(container);
    await user.type(screen.getByLabelText(/Email/), 'owner@shop.example');
    await user.click(screen.getByRole('button', { name: 'Send my part' }));

    expect(await screen.findByText(/Something went wrong sending your part/)).toBeInTheDocument();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it('thanks a submission the server took for a script, but uploads and records nothing', async () => {
    createPilotRequest.mockResolvedValue({ request_id: null, upload: null });
    const user = userEvent.setup();
    const { container } = render(<PilotRequest />);
    chooseFile(container);
    await user.type(screen.getByLabelText(/Email/), 'owner@shop.example');
    await user.click(screen.getByRole('button', { name: 'Send my part' }));

    await waitFor(() => expect(screen.getByText(/your part is with us/)).toBeInTheDocument());
    expect(uploadPilotFile).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});
