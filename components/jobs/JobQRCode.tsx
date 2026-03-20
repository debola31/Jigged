'use client';

import { useRef, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Paper from '@mui/material/Paper';
import DownloadIcon from '@mui/icons-material/Download';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { QRCodeCanvas } from 'qrcode.react';
import { jsPDF } from 'jspdf';

interface JobQRCodeProps {
  jobId: string;
  jobNumber: string;
  partName?: string | null;
  companyId: string;
  companyName?: string;
  size?: number;
}

export default function JobQRCode({
  jobId,
  jobNumber,
  partName,
  companyId,
  companyName,
  size = 200,
}: JobQRCodeProps) {
  const qrRef = useRef<HTMLDivElement>(null);

  // Generate the job URL that operators will scan
  const jobUrl = `${window.location.origin}/operator/${companyId}/login?job=${jobId}`;

  const getQRCanvas = useCallback((): HTMLCanvasElement | null => {
    if (!qrRef.current) return null;
    return qrRef.current.querySelector('canvas');
  }, []);

  const handleDownloadPNG = useCallback(() => {
    const canvas = getQRCanvas();
    if (!canvas) return;

    const dataUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `${jobNumber}-job-qr.png`;
    link.href = dataUrl;
    link.click();
  }, [getQRCanvas, jobNumber]);

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
    let yPos = 30;

    // Add company name at top if provided
    if (companyName) {
      pdf.setFontSize(14);
      pdf.setTextColor(100);
      pdf.text(companyName, pageWidth / 2, yPos, { align: 'center' });
      yPos += 15;
    }

    // Add job number as header
    pdf.setFontSize(24);
    pdf.setTextColor(0);
    pdf.text(jobNumber, pageWidth / 2, yPos, { align: 'center' });
    yPos += 10;

    // Add part name if provided
    if (partName) {
      pdf.setFontSize(16);
      pdf.setTextColor(50);
      pdf.text(partName, pageWidth / 2, yPos, { align: 'center' });
      yPos += 10;
    }

    // Add QR code
    const qrY = yPos + 5;
    pdf.addImage(dataUrl, 'PNG', qrX, qrY, qrSize, qrSize);

    // Add instruction text
    pdf.setFontSize(12);
    pdf.setTextColor(100);
    pdf.text(
      'Scan this QR code to open the Operator View for this job',
      pageWidth / 2,
      qrY + qrSize + 15,
      { align: 'center' }
    );

    // Save PDF
    pdf.save(`${jobNumber}-job-qr.pdf`);
  }, [getQRCanvas, jobNumber, partName, companyName]);

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
            value={jobUrl}
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
          startIcon={<DownloadIcon />}
          onClick={handleDownloadPNG}
        >
          Download PNG
        </Button>
        <Button
          variant="outlined"
          size="small"
          startIcon={<PictureAsPdfIcon />}
          onClick={handleDownloadPDF}
        >
          Download PDF
        </Button>
      </Box>

      {/* Scan Instruction */}
      <Typography variant="body2" color="text.secondary" sx={{ mt: 2, textAlign: 'center' }}>
        Scan this QR code from any device to open the Operator View for this job.
      </Typography>
    </Box>
  );
}
