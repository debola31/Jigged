'use client';

import { useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { QRCodeCanvas } from 'qrcode.react';
import { jsPDF } from 'jspdf';

interface StationQRCodeProps {
  workCenterId: string;
  operationName: string;
  operationCode?: string | null;
  companyId: string;
  companyName?: string;
  size?: number;
}

export default function StationQRCode({
  workCenterId,
  operationName,
  operationCode,
  companyId,
  companyName,
  size = 200,
}: StationQRCodeProps) {
  const qrRef = useRef<HTMLDivElement>(null);

  // Generate the station URL that operators will scan
  const stationUrl = `${window.location.origin}/operator/${companyId}/login?station=${workCenterId}`;

  const getQRCanvas = useCallback((): HTMLCanvasElement | null => {
    if (!qrRef.current) return null;
    return qrRef.current.querySelector('canvas');
  }, []);

  const handleDownloadPDF = useCallback(() => {
    const canvas = getQRCanvas();
    if (!canvas) return;

    const dataUrl = canvas.toDataURL('image/png');

    // Create PDF (A4 size)
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
    });

    const pageWidth = pdf.internal.pageSize.getWidth();

    // QR code size in PDF (80mm square)
    const qrSize = 80;
    const qrX = (pageWidth - qrSize) / 2;
    const qrY = 60;

    // Add company name at top if provided
    if (companyName) {
      pdf.setFontSize(14);
      pdf.setTextColor(100);
      pdf.text(companyName, pageWidth / 2, 30, { align: 'center' });
    }

    // Add station name as header
    pdf.setFontSize(24);
    pdf.setTextColor(0);
    pdf.text(operationName, pageWidth / 2, companyName ? 45 : 35, { align: 'center' });

    // Add QR code
    pdf.addImage(dataUrl, 'PNG', qrX, qrY, qrSize, qrSize);

    // Add code below QR if provided
    if (operationCode) {
      pdf.setFontSize(16);
      pdf.setTextColor(50);
      pdf.text(operationCode, pageWidth / 2, qrY + qrSize + 15, { align: 'center' });
    }

    // Add instruction text
    pdf.setFontSize(12);
    pdf.setTextColor(100);
    pdf.text(
      'Scan this QR code to open the Operator View for this station',
      pageWidth / 2,
      qrY + qrSize + (operationCode ? 30 : 15),
      { align: 'center' }
    );

    // Save PDF
    pdf.save(`${operationName.replace(/\s+/g, '-')}-station-qr.pdf`);
  }, [getQRCanvas, operationName, operationCode, companyName]);

  return (
    <Box>
      {/* QR Code Display */}
      <Paper
        elevation={0}
        sx={{
          p: 3,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          bgcolor: 'white',
          borderRadius: 2,
        }}
      >
        <div ref={qrRef}>
          <QRCodeCanvas
            value={stationUrl}
            size={size}
            level="H"
            includeMargin
            bgColor="#ffffff"
            fgColor="#000000"
          />
        </div>
      </Paper>

      {/* Export Buttons */}
      <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap', justifyContent: 'center' }}>
        <Button
          variant="outlined"
          size="small"
          startIcon={<PictureAsPdfIcon />}
          onClick={handleDownloadPDF}
        >
          Download PDF
        </Button>
        <Button
          variant="outlined"
          size="small"
          startIcon={<OpenInNewIcon />}
          href={stationUrl}
          target="_blank"
        >
          Open Operator View
        </Button>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 2, textAlign: 'center' }}>
        Scan this QR code or tap the link above to open the Operator View for this station.
      </Typography>
    </Box>
  );
}
