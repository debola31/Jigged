'use client';

import { useState, useRef, useEffect } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import ImageIcon from '@mui/icons-material/Image';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import DeleteIcon from '@mui/icons-material/Delete';
import { getCompany, updateCompanyLogo } from '@/utils/companyAccess';
import {
  uploadFileToStorage,
  deleteFileFromStorage,
  getSignedUrl,
  generateCompanyLogoPath,
} from '@/utils/storageHelpers';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp'];
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

interface CompanyBrandingCardProps {
  companyId: string;
}

export default function CompanyBrandingCard({ companyId }: CompanyBrandingCardProps) {
  const [loading, setLoading] = useState(true);
  const [logoPath, setLogoPath] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadCompany = async () => {
    try {
      setLoading(true);
      setError(null);
      const company = await getCompany(companyId);
      if (!company) {
        setError('Company not found.');
        return;
      }
      setCompanyName(company.name);
      setLogoPath(company.logo_url ?? null);
      if (company.logo_url) {
        try {
          const url = await getSignedUrl(company.logo_url, 3600);
          setLogoUrl(url);
        } catch {
          // Broken reference — show placeholder but keep the path so "Remove" works.
          setLogoUrl(null);
        }
      } else {
        setLogoUrl(null);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCompany();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file twice still triggers onChange.
    e.target.value = '';
    if (!file) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Unsupported file type. Use PNG, JPG, SVG, or WebP.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('Logo must be 2 MB or smaller.');
      return;
    }

    setError(null);
    setWorking(true);
    const newPath = generateCompanyLogoPath(companyId, file.name);
    const previousPath = logoPath;

    try {
      await uploadFileToStorage(newPath, file);
      await updateCompanyLogo(companyId, newPath);

      setLogoPath(newPath);
      // Best-effort cleanup of the prior logo.
      if (previousPath) {
        deleteFileFromStorage(previousPath).catch((err) =>
          console.warn('Failed to delete previous logo:', err)
        );
      }
      // Refresh preview.
      const url = await getSignedUrl(newPath, 3600);
      setLogoUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload logo.');
    } finally {
      setWorking(false);
    }
  };

  const handleRemove = async () => {
    if (!logoPath) return;
    setError(null);
    setWorking(true);
    const pathToDelete = logoPath;
    try {
      await updateCompanyLogo(companyId, null);
      setLogoPath(null);
      setLogoUrl(null);
      deleteFileFromStorage(pathToDelete).catch((err) =>
        console.warn('Failed to delete logo file:', err)
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove logo.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Card elevation={2}>
      <CardContent sx={{ p: 3 }}>
        <Typography variant="h6" sx={{ fontWeight: 600, mb: 1 }}>
          Company Branding
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
          Upload your company logo to brand printed quote PDFs. PNG, JPG, SVG, or
          WebP up to 2 MB.
        </Typography>

        <Divider sx={{ mb: 3 }} />

        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
          {/* Logo preview */}
          <Box
            sx={{
              width: 120,
              height: 120,
              borderRadius: 2,
              border: '1px solid',
              borderColor: 'divider',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
              bgcolor: 'background.default',
              flexShrink: 0,
            }}
          >
            {loading ? (
              <CircularProgress size={24} />
            ) : logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt={`${companyName} logo`}
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
              />
            ) : (
              <ImageIcon sx={{ fontSize: 48, color: 'text.disabled' }} />
            )}
          </Box>

          {/* Actions */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Typography variant="body1" sx={{ fontWeight: 500 }}>
              {companyName || '\u00A0'}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
              <Button
                variant="contained"
                startIcon={working ? <CircularProgress size={16} /> : <UploadFileIcon />}
                onClick={handleUploadClick}
                disabled={working || loading}
              >
                {logoPath ? 'Replace Logo' : 'Upload Logo'}
              </Button>
              {logoPath && (
                <Button
                  variant="outlined"
                  color="error"
                  startIcon={<DeleteIcon />}
                  onClick={handleRemove}
                  disabled={working}
                >
                  Remove
                </Button>
              )}
            </Box>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES.join(',')}
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}
