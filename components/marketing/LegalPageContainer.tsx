import Box from '@mui/material/Box';

interface LegalPageContainerProps {
  children: React.ReactNode;
}

/**
 * Glassmorphism container for legal pages (Terms, Privacy, Cookies).
 * Matches the Card styling from lib/theme.ts with rounded corners.
 */
export default function LegalPageContainer({ children }: LegalPageContainerProps) {
  return (
    <Box
      sx={{
        maxWidth: 780,
        mx: 'auto',
        my: { xs: 4, md: 6 },
        px: { xs: 3, md: 5 },
        py: { xs: 4, md: 6 },
        backgroundColor: 'rgb(12, 12, 24)',
        backdropFilter: 'blur(15px)',
        WebkitBackdropFilter: 'blur(15px)',
        border: '1px solid rgba(255, 255, 255, 0.15)',
        borderRadius: 3,
        overflow: 'hidden',
        // Shared typography overrides for legal content
        color: '#d1d5db',
        fontSize: 15,
        lineHeight: 1.7,
        '& h1': {
          fontSize: '2rem',
          fontWeight: 700,
          color: '#f3f4f6',
          mb: 1,
          letterSpacing: '-0.02em',
        },
        '& h2': {
          fontSize: '1.2rem',
          fontWeight: 700,
          color: '#f3f4f6',
          mt: 5,
          mb: 2,
          letterSpacing: '-0.01em',
        },
        '& h3': {
          fontSize: '1rem',
          fontWeight: 600,
          color: '#e5e7eb',
          mt: 3,
          mb: 1.5,
        },
        '& p': { mb: 2 },
        '& a': {
          color: '#4682B4',
          textDecoration: 'none',
          '&:hover': { textDecoration: 'underline' },
        },
        '& ul': { ml: 3, my: 1.5 },
        '& li': { mb: 1 },
        '& strong': { color: '#f3f4f6' },
      }}
    >
      {children}
    </Box>
  );
}
