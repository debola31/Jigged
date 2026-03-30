'use client';

import { useState, useRef } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import type { QuoteAttachment, TempAttachment } from '@/types/quote';
import {
  uploadQuoteAttachment,
  deleteQuoteAttachment,
  replaceQuoteAttachment,
  uploadTempQuoteAttachment,
  deleteTempQuoteAttachment,
  MAX_ATTACHMENTS_PER_QUOTE,
} from '@/utils/quotesAccess';

interface QuoteAttachmentUploadProps {
  quoteId: string | null; // null when creating new quote
  companyId: string;
  sessionId: string; // For temp uploads
  existingAttachments: QuoteAttachment[];
  tempAttachments?: TempAttachment[]; // For new quotes (multiple)
  onAttachmentChange: () => void;
  onTempAttachmentsChange?: (attachments: TempAttachment[]) => void; // For temp uploads
  disabled: boolean;
}

export default function QuoteAttachmentUpload({
  quoteId,
  companyId,
  sessionId,
  existingAttachments,
  tempAttachments = [],
  onAttachmentChange,
  onTempAttachmentsChange,
  disabled,
}: QuoteAttachmentUploadProps) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isCreateMode = quoteId === null;
  const totalAttachments = existingAttachments.length + tempAttachments.length;
  const canUploadMore = totalAttachments < MAX_ATTACHMENTS_PER_QUOTE;

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDate = (dateStr: string): string => {
    return new Date(dateStr).toLocaleDateString();
  };

  const handleFileSelect = async (file: File): Promise<TempAttachment | null> => {
    if (disabled) return null;

    try {
      if (isCreateMode) {
        // Upload to temp location for new quotes
        const tempAttach = await uploadTempQuoteAttachment(companyId, sessionId, file);
        return tempAttach;
      } else {
        // Upload to permanent location for existing quotes
        await uploadQuoteAttachment(quoteId!, companyId, file);
        onAttachmentChange();
        return null;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload attachment');
      return null;
    }
  };

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      // Calculate how many files we can still upload
      const remainingSlots = MAX_ATTACHMENTS_PER_QUOTE - totalAttachments;
      const filesToUpload = Array.from(files).slice(0, remainingSlots);

      if (filesToUpload.length === 0) {
        setError(`Maximum ${MAX_ATTACHMENTS_PER_QUOTE} attachments allowed.`);
        e.target.value = '';
        return;
      }

      setError(null);
      setUploading(true);

      try {
        // Upload all files and collect results
        const uploadedAttachments: TempAttachment[] = [];
        for (const file of filesToUpload) {
          const result = await handleFileSelect(file);
          if (result) {
            uploadedAttachments.push(result);
          }
        }

        // Update state once with all new attachments
        if (isCreateMode && uploadedAttachments.length > 0) {
          onTempAttachmentsChange?.([...tempAttachments, ...uploadedAttachments]);
        }

        if (files.length > remainingSlots) {
          const skipped = files.length - remainingSlots;
          setError(`${skipped} file(s) skipped. Maximum is ${MAX_ATTACHMENTS_PER_QUOTE} attachments.`);
        }
      } finally {
        setUploading(false);
      }
    }
    // Reset input so same file can be selected again
    e.target.value = '';
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (disabled || !canUploadMore) return;

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      // Calculate how many files we can still upload
      const remainingSlots = MAX_ATTACHMENTS_PER_QUOTE - totalAttachments;
      const filesToUpload = Array.from(files).slice(0, remainingSlots);

      if (filesToUpload.length === 0) {
        setError(`Maximum ${MAX_ATTACHMENTS_PER_QUOTE} attachments allowed.`);
        return;
      }

      setError(null);
      setUploading(true);

      try {
        // Upload all files and collect results
        const uploadedAttachments: TempAttachment[] = [];
        for (const file of filesToUpload) {
          const result = await handleFileSelect(file);
          if (result) {
            uploadedAttachments.push(result);
          }
        }

        // Update state once with all new attachments
        if (isCreateMode && uploadedAttachments.length > 0) {
          onTempAttachmentsChange?.([...tempAttachments, ...uploadedAttachments]);
        }

        if (files.length > remainingSlots) {
          const skipped = files.length - remainingSlots;
          setError(`${skipped} file(s) skipped. Maximum is ${MAX_ATTACHMENTS_PER_QUOTE} attachments.`);
        }
      } finally {
        setUploading(false);
      }
    }
  };

  const handleDelete = async (attachmentId?: string, tempPath?: string) => {
    if (disabled) return;

    setError(null);
    setUploading(true);

    try {
      if (isCreateMode && tempPath) {
        // Delete temp attachment
        await deleteTempQuoteAttachment(tempPath);
        // Remove from array
        onTempAttachmentsChange?.(tempAttachments.filter(a => a.file_path !== tempPath));
      } else if (attachmentId) {
        // Delete permanent attachment
        await deleteQuoteAttachment(attachmentId, companyId);
        onAttachmentChange();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete attachment');
    } finally {
      setUploading(false);
    }
  };

  const handleReplace = async (attachmentId: string, file: File) => {
    if (disabled || !quoteId) return;

    setError(null);
    setUploading(true);

    try {
      await replaceQuoteAttachment(attachmentId, companyId, quoteId, file);
      onAttachmentChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to replace attachment');
    } finally {
      setUploading(false);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const triggerReplaceInput = (attachmentId: string) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        handleReplace(attachmentId, file);
      }
    };
    input.click();
  };

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {disabled && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Attachments can only be modified in pending approval or rejected quotes.
        </Alert>
      )}

      {/* Existing Attachments */}
      {existingAttachments.length > 0 && (
        <Box sx={{ mb: 2 }}>
          {existingAttachments.map((attachment) => (
            <Box
              key={attachment.id}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                p: 2,
                bgcolor: 'rgba(255, 255, 255, 0.05)',
                borderRadius: 1,
                border: '1px solid rgba(255, 255, 255, 0.1)',
                mb: 1,
              }}
            >
              <PictureAsPdfIcon sx={{ fontSize: 40, color: 'error.main' }} />
              <Box sx={{ flex: 1 }}>
                <Typography variant="body1" fontWeight={500}>
                  {attachment.file_name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatFileSize(attachment.file_size)} • Uploaded {formatDate(attachment.uploaded_at)}
                </Typography>
              </Box>
              {!disabled && !uploading && (
                <>
                  <IconButton
                    color="primary"
                    onClick={() => triggerReplaceInput(attachment.id)}
                    title="Replace attachment"
                    aria-label="Replace attachment"
                    sx={{ minWidth: 48, minHeight: 48 }}
                  >
                    <EditIcon />
                  </IconButton>
                  <IconButton
                    color="error"
                    onClick={() => handleDelete(attachment.id)}
                    title="Delete attachment"
                    aria-label="Delete attachment"
                    sx={{ minWidth: 48, minHeight: 48 }}
                  >
                    <DeleteIcon />
                  </IconButton>
                </>
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* Temp Attachments (for new quotes) */}
      {tempAttachments.length > 0 && (
        <Box sx={{ mb: 2 }}>
          {tempAttachments.map((attachment, index) => (
            <Box
              key={attachment.file_path}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                p: 2,
                bgcolor: 'rgba(255, 255, 255, 0.05)',
                borderRadius: 1,
                border: '1px solid rgba(255, 255, 255, 0.1)',
                mb: 1,
              }}
            >
              <PictureAsPdfIcon sx={{ fontSize: 40, color: 'error.main' }} />
              <Box sx={{ flex: 1 }}>
                <Typography variant="body1" fontWeight={500}>
                  {attachment.file_name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {formatFileSize(attachment.file_size)} • Ready to upload
                </Typography>
              </Box>
              {!disabled && !uploading && (
                <IconButton
                  color="error"
                  onClick={() => handleDelete(undefined, attachment.file_path)}
                  title="Delete attachment"
                  aria-label="Delete attachment"
                  sx={{ minWidth: 48, minHeight: 48 }}
                >
                  <DeleteIcon />
                </IconButton>
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* Upload Area */}
      {canUploadMore && !disabled && (
        <Box
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          sx={{
            border: '2px dashed',
            borderColor: dragActive ? 'primary.main' : 'rgba(255, 255, 255, 0.2)',
            borderRadius: 1,
            p: 4,
            textAlign: 'center',
            bgcolor: dragActive ? 'rgba(70, 130, 180, 0.1)' : 'transparent',
            cursor: uploading ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s',
            '&:hover': {
              borderColor: uploading ? 'rgba(255, 255, 255, 0.2)' : 'primary.main',
              bgcolor: uploading ? 'transparent' : 'rgba(70, 130, 180, 0.05)',
            },
          }}
          onClick={uploading ? undefined : triggerFileInput}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            multiple
            onChange={handleFileInputChange}
            style={{ display: 'none' }}
            disabled={uploading}
            aria-label="Upload PDF attachments"
          />

          {uploading ? (
            <Box>
              <CircularProgress size={48} sx={{ mb: 2 }} />
              <Typography variant="body1">Uploading...</Typography>
            </Box>
          ) : (
            <Box>
              <UploadFileIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
              <Typography variant="body1" gutterBottom>
                Drag and drop PDF files here, or click to select
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Maximum file size: 50MB • Up to {MAX_ATTACHMENTS_PER_QUOTE} files • PDF files only
              </Typography>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
