'use client';

/**
 * "Here is the mill cert for this heat" — chosen while the heat is being typed.
 *
 * ## Where it appears, and why there
 *
 * Beside the heat number, and only once one has been entered. The first build offered the cert
 * AFTER the receipt was submitted, in a panel that replaced the form. It worked, but it put the
 * question at the wrong moment: the cert is the piece of paper stapled to the bar you are looking
 * at while you type its heat off the tag, and a prompt that arrives once you have already pressed
 * Confirm reads as an interruption rather than part of the same act.
 *
 * Clearing the heat clears the cert with it. A staged file with no heat would upload against a lot
 * minted for material we could not identify, which is not what anyone chose.
 *
 * ## Selection only; the upload happens after the write
 *
 * This holds a `File` and hands it up — the same shape as {@link MovementPhotoField}, for the
 * opposite reason. That component cannot upload later, because `photo_path` is written at INSERT
 * and immutable. This one cannot upload EARLIER: a certificate needs a `lot_id`, and the lot does
 * not exist until `add_stock_at_location` creates it. Both stage a file; one uploads before the
 * RPC and one after, and neither had a choice.
 *
 * That is also what keeps the promise the whole feature turns on: because the cert is a second,
 * later write, a failed one cannot un-land the stock.
 */

import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';

import { CERT_ACCEPT_ATTR, validateLotCertificateFile } from '@/utils/lotCertificatesAccess';

interface MillCertFieldProps {
  value: File | null;
  onChange: (file: File | null) => void;
  disabled?: boolean;
}

export default function MillCertField({ value, onChange, disabled = false }: MillCertFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = (file: File | undefined) => {
    if (!file) return;
    const invalid = validateLotCertificateFile(file);
    if (invalid) {
      setError(invalid);
      onChange(null);
      return;
    }
    setError(null);
    onChange(file);
  };

  return (
    <Box>
      {/* No `capture`: the scan already exists as a PDF on a desk, which is the whole premise —
          the native sheet has to offer Files as well as the camera. */}
      <input
        ref={inputRef}
        type="file"
        accept={CERT_ACCEPT_ATTR}
        hidden
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared first, so re-picking the same file fires change again.
          e.target.value = '';
          pick(file);
        }}
      />

      {value ? (
        <Stack direction="row" spacing={1} alignItems="center">
          <DescriptionOutlinedIcon fontSize="small" color="primary" />
          <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
            {value.name}
          </Typography>
          <IconButton
            aria-label="Remove the certificate"
            size="small"
            disabled={disabled}
            onClick={() => {
              setError(null);
              onChange(null);
            }}
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Stack>
      ) : (
        <Button
          size="small"
          startIcon={<DescriptionOutlinedIcon />}
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          Attach the mill cert (optional)
        </Button>
      )}

      {/* A rejected file is worth saying out loud — nothing left the browser, and the person is
          holding the right document in the wrong format. Never blocks the receipt. */}
      {error && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </Box>
  );
}
