'use client';

/**
 * The vendors an RFQ asks (plan §3.9 "Per vendor"; criterion Q1): for each, its own preview, an
 * email to the contact frozen when it was invited, "Mark sent", Declined / Undo, and the quote.
 *
 * Sending is "PDF plus mailto, like quotes" (founder decision): Jigged never emails anyone. "Mark
 * sent" is the person saying it went, and stamps it — it can be pressed again for a resend.
 * Declining is reversible and refuses that vendor's quotes until undone, so it takes no dialog.
 */
import { useState } from 'react';
import NextLink from 'next/link';
import posthog from 'posthog-js';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';

import ErrorAlert from '@/components/common/ErrorAlert';
import { formatDateOnly } from '@/lib/localDate';
import { rfqEmailHref } from '@/utils/rfqPdf';
import { setVendorRfqInvitationState } from '@/utils/vendorRfqAccess';
import type { VendorRfqDetail, VendorRfqInvitation, VendorRfqInvitationAction } from '@/types/vendorRfq';

export interface RfqVendorsCardProps {
  companyId: string;
  rfq: VendorRfqDetail;
  /** Closed or archived: the preview and the email stay, every write goes. */
  readOnly: boolean;
  onPreview: (invitationId: string) => void;
  onRecordQuote: (invitationId: string) => void;
  /** After a write: the page refreshes once. */
  onChanged: () => void;
}

/** "Quoted 3 of 4 prices" — what this vendor has answered so far, in words. */
function quoteSummary(rfq: VendorRfqDetail, invitation: VendorRfqInvitation): string | null {
  const own = rfq.responses.filter((r) => r.invitationId === invitation.id);
  if (own.length === 0) return null;
  const asked = rfq.lines.reduce((n, l) => n + l.quantities.length, 0);
  const priced = own.filter((r) => !r.noBid && r.unitPrice !== null).length;
  if (priced === 0) return 'No bid on anything';
  const awarded = own.filter((r) => r.awardedAt !== null).length;
  const base = `Quoted ${priced} of ${asked} ${asked === 1 ? 'price' : 'prices'}`;
  return awarded > 0 ? `${base} · awarded ${awarded}` : base;
}

export default function RfqVendorsCard({
  companyId,
  rfq,
  readOnly,
  onPreview,
  onRecordQuote,
  onChanged,
}: RfqVendorsCardProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const act = async (invitation: VendorRfqInvitation, action: VendorRfqInvitationAction) => {
    setBusy(invitation.id);
    setError(null);
    try {
      await setVendorRfqInvitationState(invitation.id, action);
      if (action === 'mark_sent') {
        posthog.capture('vendor rfq sent', { is_resend: invitation.sentAt !== null });
      }
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          Vendors asked
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Each vendor gets its own copy, with its own part numbers and no prices. Download it from the preview, email
          it, then mark it sent.
        </Typography>

        <ErrorAlert error={error} entity="RFQ" onClose={() => setError(null)} sx={{ mb: 2 }} />

        {rfq.invitations.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No vendors yet. Edit the RFQ to choose who to ask.
          </Typography>
        ) : (
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {rfq.invitations.map((inv) => {
              const contact = inv.vendorContact;
              const contactName = contact?.name?.trim() || null;
              const href = rfqEmailHref({
                rfqNumber: rfq.header.rfqNumber,
                title: rfq.header.title,
                respondByOn: rfq.header.respondByOn,
                shopName: rfq.header.shipToName,
                contact,
              });
              const declined = inv.declinedAt !== null;
              const summary = quoteSummary(rfq, inv);
              const hasQuote = rfq.responses.some((r) => r.invitationId === inv.id);
              const disabled = busy !== null;
              let status: string;
              if (declined) {
                status = `Declined ${formatDateOnly(inv.declinedAt)}${inv.declinedReason ? ` — ${inv.declinedReason}` : ''}`;
              } else if (inv.sentAt) {
                status = `Sent ${formatDateOnly(inv.sentAt)}`;
              } else {
                status = 'Not sent yet';
              }

              return (
                <Box
                  component="li"
                  key={inv.id}
                  aria-label={inv.vendorName}
                  sx={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 2,
                    flexWrap: 'wrap',
                    p: 1.5,
                    mb: 1,
                    border: 1,
                    borderColor: 'divider',
                    borderRadius: 1,
                  }}
                >
                  <Box sx={{ minWidth: 220, flex: '1 1 260px' }}>
                    <MuiLink
                      component={NextLink}
                      href={`/dashboard/${companyId}/vendors/${inv.vendorId}`}
                      underline="hover"
                      color="inherit"
                      sx={{ fontWeight: 600 }}
                    >
                      {inv.vendorName}
                    </MuiLink>
                    <Typography variant="body2" color="text.secondary">
                      {contactName ?? 'No contact on file'}
                      {contact?.email ? ` · ${contact.email}` : ''}
                      {contact?.phone ? ` · ${contact.phone}` : ''}
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 0.5 }}>
                      {status}
                      {summary ? ` · ${summary}` : ''}
                    </Typography>
                  </Box>

                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Button variant="outlined" size="small" onClick={() => onPreview(inv.id)} disabled={disabled}>
                      Preview
                    </Button>
                    {href ? (
                      <Button variant="outlined" size="small" component="a" href={href} disabled={disabled}>
                        Email {contactName ?? inv.vendorName}
                      </Button>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        No email on file
                      </Typography>
                    )}
                    {!readOnly && !declined && (
                      <>
                        <Button variant="outlined" size="small" onClick={() => act(inv, 'mark_sent')} disabled={disabled}>
                          {inv.sentAt ? 'Mark sent again' : 'Mark sent'}
                        </Button>
                        <Button variant="outlined" size="small" onClick={() => onRecordQuote(inv.id)} disabled={disabled}>
                          {hasQuote ? 'Edit quote' : 'Record quote'}
                        </Button>
                        <Button variant="outlined" size="small" onClick={() => act(inv, 'decline')} disabled={disabled}>
                          Declined
                        </Button>
                      </>
                    )}
                    {!readOnly && declined && (
                      <Button variant="outlined" size="small" onClick={() => act(inv, 'undo_decline')} disabled={disabled}>
                        Undo decline
                      </Button>
                    )}
                  </Box>
                </Box>
              );
            })}
          </Box>
        )}
      </CardContent>
    </Card>
  );
}
