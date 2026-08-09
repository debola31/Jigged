import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '../../test-utils';
import userEvent from '@testing-library/user-event';

/**
 * The company logo upload.
 *
 * Worth noting what this feature actually was before this batch: `companies.logo_url` was read by
 * two PDF generators, `updateCompanyLogo` and `generateCompanyLogoPath` both existed with zero
 * callers, and `loadLogoAsDataUrl` read a `logos` bucket that no migration created. Three quarters
 * written, zero percent reachable, and silent about it — which is why the tests below care as much
 * about the order of operations as about the happy path.
 */

const getCompany = vi.hoisted(() => vi.fn());
const updateCompanyLogo = vi.hoisted(() => vi.fn());
const uploadFileToStorage = vi.hoisted(() => vi.fn());
const deleteFileFromStorage = vi.hoisted(() => vi.fn());
const getSignedUrl = vi.hoisted(() => vi.fn());

vi.mock('@/utils/companyAccess', () => ({ getCompany, updateCompanyLogo }));
vi.mock('@/utils/storageHelpers', async () => {
  const actual = await vi.importActual<typeof import('@/utils/storageHelpers')>(
    '@/utils/storageHelpers',
  );
  return {
    ...actual,
    uploadFileToStorage,
    deleteFileFromStorage,
    getSignedUrl,
    generateCompanyLogoPath: (companyId: string, name: string) => `${companyId}/company/logo_ab_${name}`,
  };
});

import CompanyLogoCard, { rejectLogoFile } from '@/components/settings/CompanyLogoCard';
import { LOGOS_BUCKET } from '@/utils/storageHelpers';

const CO = '71000000-0000-0000-0000-000000000002';

const png = (name = 'mark.png', size = 1000) =>
  new File([new Uint8Array(size)], name, { type: 'image/png' });

beforeEach(() => {
  vi.clearAllMocks();
  getCompany.mockResolvedValue({ id: CO, name: 'Acme', logo_url: null });
  getSignedUrl.mockResolvedValue('https://signed.example/logo.png');
  uploadFileToStorage.mockResolvedValue(undefined);
  updateCompanyLogo.mockResolvedValue(undefined);
  deleteFileFromStorage.mockResolvedValue(undefined);
});

describe('rejectLogoFile', () => {
  it('accepts the two formats jsPDF can actually embed', () => {
    expect(rejectLogoFile({ type: 'image/png', size: 1000 })).toBeNull();
    expect(rejectLogoFile({ type: 'image/jpeg', size: 1000 })).toBeNull();
  });

  it('refuses anything else by name, including SVG', () => {
    // SVG is a scripting surface and jsPDF cannot embed it — "it looked like an image" is not a
    // reason to accept a file into a bucket.
    expect(rejectLogoFile({ type: 'image/svg+xml', size: 1000 })).toMatch(/PNG or a JPEG/);
    expect(rejectLogoFile({ type: 'application/pdf', size: 1000 })).toMatch(/PNG or a JPEG/);
  });

  it('refuses a file past the cap, in the same units the bucket uses', () => {
    expect(rejectLogoFile({ type: 'image/png', size: 2 * 1024 * 1024 + 1 })).toMatch(/2 MB/);
    expect(rejectLogoFile({ type: 'image/png', size: 2 * 1024 * 1024 })).toBeNull();
  });
});

describe('CompanyLogoCard', () => {
  it('says there is no logo rather than showing a broken frame', async () => {
    render(<CompanyLogoCard companyId={CO} />);
    expect(await screen.findByText('No logo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload logo/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('previews an existing logo from a signed URL against the private bucket', async () => {
    getCompany.mockResolvedValue({ id: CO, name: 'Acme', logo_url: `${CO}/company/logo_x.png` });
    render(<CompanyLogoCard companyId={CO} />);

    const img = await screen.findByAltText('Company logo');
    expect(img).toHaveAttribute('src', 'https://signed.example/logo.png');
    expect(getSignedUrl).toHaveBeenCalledWith(`${CO}/company/logo_x.png`, 3600, LOGOS_BUCKET);
  });

  it('refuses a bad file before it reaches the network', async () => {
    render(<CompanyLogoCard companyId={CO} />);
    await screen.findByText('No logo');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    // `applyAccept: false` deliberately: the input's `accept` attribute is a picker hint, not an
    // enforcement point — drag-and-drop and a programmatic `files` assignment both walk past it.
    // The check being tested is the one in code, which is the one that always runs.
    await userEvent.upload(input, new File(['x'], 'logo.svg', { type: 'image/svg+xml' }), {
      applyAccept: false,
    });

    expect(await screen.findByText(/PNG or a JPEG/)).toBeInTheDocument();
    expect(uploadFileToStorage).not.toHaveBeenCalled();
    expect(updateCompanyLogo).not.toHaveBeenCalled();
  });

  it('uploads to the logos bucket and records the path on the company', async () => {
    render(<CompanyLogoCard companyId={CO} />);
    await screen.findByText('No logo');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, png());

    await waitFor(() =>
      expect(uploadFileToStorage).toHaveBeenCalledWith(
        `${CO}/company/logo_ab_mark.png`,
        expect.any(File),
        LOGOS_BUCKET,
      ),
    );
    expect(updateCompanyLogo).toHaveBeenCalledWith(CO, `${CO}/company/logo_ab_mark.png`);
  });

  it('replaces by writing the new file first, then dropping the old one', async () => {
    getCompany.mockResolvedValue({ id: CO, name: 'Acme', logo_url: `${CO}/company/old.png` });
    render(<CompanyLogoCard companyId={CO} />);
    await screen.findByAltText('Company logo');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, png());

    await waitFor(() =>
      expect(deleteFileFromStorage).toHaveBeenCalledWith(`${CO}/company/old.png`, LOGOS_BUCKET),
    );
    // Order matters: a failure part-way must leave the OLD logo working, never neither.
    expect(uploadFileToStorage.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFileFromStorage.mock.invocationCallOrder[0],
    );
    expect(updateCompanyLogo.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFileFromStorage.mock.invocationCallOrder[0],
    );
  });

  it('keeps the new logo even when the old file cannot be removed', async () => {
    getCompany.mockResolvedValue({ id: CO, name: 'Acme', logo_url: `${CO}/company/old.png` });
    deleteFileFromStorage.mockRejectedValue(new Error('gone'));
    render(<CompanyLogoCard companyId={CO} />);
    await screen.findByAltText('Company logo');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, png());

    await waitFor(() => expect(updateCompanyLogo).toHaveBeenCalled());
    // An orphaned object costs a few KB. Surfacing it as a failed save would cost the user a logo
    // they successfully uploaded.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the row before deleting the file, so no document points at a missing object', async () => {
    getCompany.mockResolvedValue({ id: CO, name: 'Acme', logo_url: `${CO}/company/old.png` });
    render(<CompanyLogoCard companyId={CO} />);
    await screen.findByAltText('Company logo');

    await userEvent.click(screen.getByRole('button', { name: /remove/i }));

    await waitFor(() => expect(updateCompanyLogo).toHaveBeenCalledWith(CO, null));
    expect(updateCompanyLogo.mock.invocationCallOrder[0]).toBeLessThan(
      deleteFileFromStorage.mock.invocationCallOrder[0],
    );
    expect(await screen.findByText('No logo')).toBeInTheDocument();
  });

  it('admits a logo it cannot load instead of claiming there is none', async () => {
    getCompany.mockResolvedValue({ id: CO, name: 'Acme', logo_url: `${CO}/company/old.png` });
    getSignedUrl.mockRejectedValue(new Error('denied'));
    render(<CompanyLogoCard companyId={CO} />);

    // "No logo" here would hide a real inconsistency between the row and the bucket.
    expect(await screen.findByText(/on file but couldn't be loaded/i)).toBeInTheDocument();
  });
});
