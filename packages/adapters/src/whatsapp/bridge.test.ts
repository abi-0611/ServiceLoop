import type { ChannelSendRequest } from '@serviceloop/domain';
import { describe, expect, it } from 'vitest';
import { WhatsAppChannelSender, WhatsAppMediaFetcher } from './channel-sender';
import { SandboxWhatsAppAdapter } from './sandbox-adapter';
import { toInboundMessage } from './to-domain';
import type { InboundEvent } from './types';

/**
 * The two translations between the domain and WhatsApp.
 *
 * Both are thin, and both are exactly the kind of thin code that silently
 * changes meaning: a template category mapped to the wrong taxonomy, a voice
 * note that loses the flag that says it is one.
 */

const SHOP = '01920000-0000-7000-8000-0000000000aa';

function request(content: ChannelSendRequest['content']): ChannelSendRequest {
  return { shopId: SHOP, to: '+919841100001', content };
}

const eventBase = {
  waMessageId: 'wamid.X1',
  from: '+919841100001',
  fromDisplayName: 'Ravi',
  to: '000000000000000',
  timestamp: new Date('2026-08-14T08:30:00.000Z'),
  groupId: null,
  contextMessageId: null,
};

describe('WhatsAppChannelSender', () => {
  it('sends each content kind through the matching port method', async () => {
    const adapter = new SandboxWhatsAppAdapter({ deliveryMode: 'manual' });
    const sender = new WhatsAppChannelSender(adapter);

    await sender.send(request({ kind: 'text', body: 'Your vehicle is ready.' }));
    await sender.send(
      request({
        kind: 'interactive',
        body: 'Confirm this job card?',
        buttons: [
          { id: 'yes', title: 'Confirm' },
          { id: 'no', title: 'Discard' },
        ],
      }),
    );
    await sender.send(
      request({
        kind: 'media',
        mediaId: 'm1',
        mediaKind: 'PHOTO',
        contentType: 'image/jpeg',
        bytes: Buffer.from('jpeg'),
        caption: 'Worn pads',
      }),
    );

    expect(adapter.transcript().map((entry) => entry.kind)).toEqual([
      'text',
      'interactive',
      'media',
    ]);
  });

  it('maps a SERVICE conversation category onto a UTILITY template registration', async () => {
    const adapter = new SandboxWhatsAppAdapter({ deliveryMode: 'manual' });
    const sender = new WhatsAppChannelSender(adapter);

    await sender.send(
      request({
        kind: 'template',
        templateName: 'job_card_opened',
        templateLanguage: 'ta',
        // SERVICE exists on the pricing taxonomy but not the template one.
        category: 'SERVICE',
        variables: ['JC-2026-0001'],
        preview: 'Job card JC-2026-0001 opened.',
      }),
    );

    expect(adapter.transcript().at(-1)?.template?.category).toBe('UTILITY');
  });

  it('carries a marketing template category through unchanged', async () => {
    const adapter = new SandboxWhatsAppAdapter({ deliveryMode: 'manual' });
    const sender = new WhatsAppChannelSender(adapter);

    await sender.send(
      request({
        kind: 'template',
        templateName: 'service_due',
        templateLanguage: 'en',
        category: 'MARKETING',
        variables: [],
        preview: 'Your service is due.',
      }),
    );

    expect(adapter.transcript().at(-1)?.template?.category).toBe('MARKETING');
  });

  it('renders a list payload when the content carries sections', async () => {
    const adapter = new SandboxWhatsAppAdapter({ deliveryMode: 'manual' });
    const sender = new WhatsAppChannelSender(adapter);

    await sender.send(
      request({
        kind: 'interactive',
        body: 'Which slot suits you?',
        listButtonLabel: 'Pick a slot',
        sections: [
          {
            title: 'Tomorrow',
            rows: [
              { id: 'am', title: 'Morning', description: '9am – 12pm' },
              { id: 'pm', title: 'Afternoon' },
            ],
          },
        ],
      }),
    );

    const payload = adapter.transcript().at(-1)?.interactive;
    expect(payload?.kind).toBe('list');
    expect(payload?.kind === 'list' ? payload.sections[0]?.rows.length : 0).toBe(2);
  });
});

describe('WhatsAppMediaFetcher', () => {
  it('returns the bytes the adapter holds for an inbound reference', async () => {
    const adapter = new SandboxWhatsAppAdapter({ deliveryMode: 'manual' });
    const fetcher = new WhatsAppMediaFetcher(adapter);

    const delivery = adapter.injectInbound({
      kind: 'media',
      from: '+919841100001',
      mediaKind: 'PHOTO',
      bytes: Buffer.from('a photographed job card'),
      contentType: 'image/jpeg',
      caption: '#jobcard',
    });
    const batch = await adapter.receive(delivery);
    const event = batch.events[0];
    if (event?.kind !== 'media') throw new Error('expected a media event');

    const fetched = await fetcher.download(SHOP, {
      providerMediaId: event.media.providerMediaId,
      mimeType: event.media.mimeType,
    });

    expect(fetched.bytes.toString()).toBe('a photographed job card');
    expect(fetched.contentType).toBe('image/jpeg');
  });
});

describe('toInboundMessage', () => {
  it('keeps the voice-note flag, which decides whether audio is intake', () => {
    const event: InboundEvent = {
      ...eventBase,
      kind: 'media',
      mediaKind: 'AUDIO',
      caption: null,
      media: {
        providerMediaId: 'media-1',
        mimeType: 'audio/ogg',
        sha256: null,
        fileSizeBytes: 2048,
        filename: null,
        isVoiceNote: true,
      },
    };

    const message = toInboundMessage(event);
    expect(message.kind).toBe('AUDIO');
    expect(message.media?.isVoiceNote).toBe(true);
  });

  it('preserves the reply id a button tap carries, which the draft actions parse', () => {
    const message = toInboundMessage({
      ...eventBase,
      kind: 'button_reply',
      replyId: 'intake:confirm:01920000-0000-7000-8000-0000000000ff',
      title: 'Confirm',
    });

    expect(message.kind).toBe('BUTTON_REPLY');
    expect(message.replyId).toBe('intake:confirm:01920000-0000-7000-8000-0000000000ff');
  });

  it('turns an unmodelled type into a visible placeholder rather than dropping it', () => {
    const message = toInboundMessage({
      ...eventBase,
      kind: 'unsupported',
      providerType: 'contacts',
    });

    expect(message.kind).toBe('UNSUPPORTED');
    expect(message.text).toBe('[contacts]');
  });

  it('carries a caption separately from the body, so `#jobcard` is still a trigger', () => {
    const message = toInboundMessage({
      ...eventBase,
      kind: 'media',
      mediaKind: 'PHOTO',
      caption: '#jobcard Ravi anna',
      media: {
        providerMediaId: 'media-2',
        mimeType: 'image/jpeg',
        sha256: null,
        fileSizeBytes: 100,
        filename: 'card.jpg',
        isVoiceNote: false,
      },
    });

    expect(message.text).toBe('');
    expect(message.caption).toBe('#jobcard Ravi anna');
  });
});
