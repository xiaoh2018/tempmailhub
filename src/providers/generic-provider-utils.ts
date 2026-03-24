import type { EmailContact, EmailMessage, EmailAttachment } from '../types/email.js';
import { parseDate, simpleHash, stripHtml } from '../utils/helpers.js';

function firstNonEmptyString(candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue;
    }

    const value = String(candidate).trim();
    if (value) {
      return value;
    }
  }

  return '';
}

function joinTextValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map(item => {
        if (item === undefined || item === null) {
          return '';
        }

        return typeof item === 'string' ? item : String(item);
      })
      .filter(Boolean)
      .join('\n');
  }

  return typeof value === 'string' ? value : '';
}

function looksLikeHtml(value: string): boolean {
  return /<([a-z][\w:-]*)(?:\s[^>]*)?>/i.test(String(value || ''));
}

export function extractAddress(value: unknown): string {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractAddress(item);
      if (extracted) {
        return extracted;
      }
    }

    return '';
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return firstNonEmptyString([
      record.address,
      record.email,
      record.mail,
      record.value,
      record.name,
      record.text
    ]);
  }

  return '';
}

function toContacts(value: unknown, fallbackEmail?: string): EmailContact[] {
  if (Array.isArray(value)) {
    const contacts = value
      .map(item => {
        if (!item) {
          return null;
        }

        if (typeof item === 'string') {
          return { email: item };
        }

        if (typeof item === 'object') {
          const record = item as Record<string, unknown>;
          const email = extractAddress(record);
          if (!email) {
            return null;
          }

          const name = firstNonEmptyString([record.name, record.text]);
          return {
            email,
            name: name || undefined
          };
        }

        return null;
      })
      .filter((item): item is EmailContact => item !== null);

    if (contacts.length) {
      return contacts;
    }
  }

  const single = extractAddress(value) || firstNonEmptyString([fallbackEmail]);
  return single ? [{ email: single }] : [];
}

export function buildStableMessageId(
  providerName: string,
  fallbackMailboxAddress: string,
  detail: Record<string, unknown>
): string {
  const explicit = firstNonEmptyString([
    detail.id,
    detail.messageId,
    detail.message_id,
    detail.msgid,
    detail.mail_id
  ]);

  if (explicit) {
    return explicit;
  }

  const fingerprint = [
    providerName,
    fallbackMailboxAddress,
    firstNonEmptyString([detail.subject, detail.title]),
    extractAddress(detail.from) || extractAddress(detail.sender) || firstNonEmptyString([detail.from_mail]),
    firstNonEmptyString([
      detail.date,
      detail.createdAt,
      detail.created_at,
      detail.updatedAt,
      detail.receivedAt,
      detail.timestamp
    ]),
    firstNonEmptyString([detail.text, detail.body, detail.intro, detail.content, detail.snippet])
  ].join('|');

  return `${providerName}-${Math.abs(simpleHash(fingerprint))}`;
}

export function normalizeGenericEmailMessage(
  detail: Record<string, unknown>,
  providerName: string,
  fallbackMailboxAddress: string
): EmailMessage {
  const contentValue = joinTextValue(detail.content);
  const senderEmail = extractAddress(detail.from) || extractAddress(detail.sender) || firstNonEmptyString([
    detail.from_mail,
    detail.fromEmail,
    detail.from_email,
    detail.fromAddress,
    detail.from_address,
    detail.senderAddress,
    detail.sender_address,
    detail.replyToEmail,
    detail.reply_to_email,
    detail.sender_email
  ]);

  const htmlContent = firstNonEmptyString([
    joinTextValue(detail.htmlContent),
    joinTextValue(detail.html_content),
    joinTextValue(detail.html),
    detail.htmlBody,
    detail.html_body,
    detail.body_html,
    detail.content_html,
    looksLikeHtml(contentValue) ? contentValue : ''
  ]);

  const textContent = firstNonEmptyString([
    detail.textContent,
    detail.text_content,
    detail.text,
    detail.body,
    detail.body_text,
    detail.plain,
    detail.plainText,
    detail.plain_text,
    detail.content_text,
    !looksLikeHtml(contentValue) ? contentValue : '',
    detail.snippet,
    detail.intro,
    htmlContent ? stripHtml(htmlContent) : ''
  ]);

  const attachments = Array.isArray(detail.attachments)
    ? detail.attachments.map((attachment, index) => {
        if (attachment && typeof attachment === 'object') {
          const record = attachment as Record<string, unknown>;
          return {
            id: firstNonEmptyString([record.id, record.cid, `${providerName}-attachment-${index}`]),
            filename: firstNonEmptyString([record.filename, record.name, `attachment-${index + 1}`]),
            contentType: firstNonEmptyString([record.contentType, record.type, 'application/octet-stream']),
            size: Number(record.size || 0),
            downloadUrl: firstNonEmptyString([record.downloadUrl, record.url]) || undefined,
            inline: Boolean(record.inline),
            contentId: firstNonEmptyString([record.contentId, record.cid]) || undefined
          } satisfies EmailAttachment;
        }

        return {
          id: `${providerName}-attachment-${index}`,
          filename: `attachment-${index + 1}`,
          contentType: 'application/octet-stream',
          size: 0
        } satisfies EmailAttachment;
      })
    : undefined;

  const messageId = firstNonEmptyString([detail.messageId, detail.message_id, detail.msgid]) || undefined;

  return {
    id: buildStableMessageId(providerName, fallbackMailboxAddress, detail),
    from: {
      email: senderEmail,
      name: firstNonEmptyString([
        typeof detail.from === 'object' && detail.from !== null
          ? firstNonEmptyString([
              (detail.from as Record<string, unknown>).name,
              (detail.from as Record<string, unknown>).text
            ])
          : '',
        detail.fromName,
        detail.from_name,
        detail.senderName,
        detail.sender_name
      ]) || undefined
    },
    to: toContacts(detail.to, extractAddress(detail.recipient) || fallbackMailboxAddress),
    cc: Array.isArray(detail.cc) ? toContacts(detail.cc) : undefined,
    bcc: Array.isArray(detail.bcc) ? toContacts(detail.bcc) : undefined,
    subject: firstNonEmptyString([detail.subject, detail.title, detail.header]),
    textContent,
    htmlContent,
    receivedAt: parseDate(firstNonEmptyString([
      detail.receivedAt,
      detail.received_at,
      detail.createdAt,
      detail.created_at,
      detail.updatedAt,
      detail.updated_at,
      detail.sentAt,
      detail.sent_at,
      detail.date,
      detail.timestamp,
      new Date().toISOString()
    ])),
    isRead: Boolean(detail.isRead ?? detail.is_read ?? detail.read ?? detail.seen),
    provider: providerName,
    messageId,
    attachments,
    headers: messageId ? { 'Message-ID': messageId } : undefined
  };
}
