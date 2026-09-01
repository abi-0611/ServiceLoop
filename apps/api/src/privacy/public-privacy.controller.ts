import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import { getEnv } from '@serviceloop/config';
import type { Tx } from '@serviceloop/db';
import type { DataPrincipalService } from '@serviceloop/domain';
import type { Response } from 'express';
import { z } from 'zod';
import { Public } from '../auth/auth.types';
import { ZodQuery } from '../common/zod';
import { DATA_PRINCIPAL_SERVICE } from './privacy.tokens';

/**
 * The two things a *customer* — who has no console account — needs to reach.
 *
 * Both are `@Public()`, and each protects itself rather than relying on a
 * session, because the person they are for cannot have one:
 *
 * - the archive download, whose credential is a 256-bit token delivered to the
 *   customer's own WhatsApp thread, single-purpose and expiring;
 * - the grievance contact, which is a statutory publication requirement and
 *   carries no personal data at all.
 *
 * `webhook-signatures.test.ts` pins the set of public routes, so these appear
 * in a diff alongside the reason they are allowed to be public.
 */
@Controller('privacy')
export class PublicPrivacyController {
  constructor(
    @Inject(DATA_PRINCIPAL_SERVICE) private readonly service: DataPrincipalService<Tx>,
  ) {}

  /**
   * The grievance contact and the retention summary, in machine-readable form.
   *
   * The Act requires a shop to publish who to complain to. Serving it from the
   * API as well as rendering it on the console's `/privacy` page means the
   * notice and the running system cannot drift: the page reads this.
   */
  @Public()
  @Get('notice')
  notice() {
    const env = getEnv();
    return {
      grievanceOfficer: {
        name: env.DPDP_GRIEVANCE_NAME,
        email: env.DPDP_GRIEVANCE_EMAIL,
        phone: env.DPDP_GRIEVANCE_PHONE,
      },
      noticeUrl: env.PRIVACY_NOTICE_URL,
      rights: [
        { right: 'access', how: 'Ask the workshop for a copy of your data.' },
        { right: 'correction', how: 'Ask the workshop to correct anything that is wrong.' },
        { right: 'erasure', how: 'Ask the workshop to delete your data.' },
        {
          right: 'grievance',
          how: 'If you are not satisfied, contact the grievance officer above.',
        },
      ],
      retention: {
        invoicesYears: env.DPDP_INVOICE_RETENTION_YEARS,
        basis: 'CGST Act 2017 s.36 — books and accounts',
        note:
          'Tax invoices are kept for this period even after an erasure request, with your name and contact details removed.',
      },
    };
  }

  /**
   * Exchanges a download token for the archive.
   *
   * `@Public()` and unauthenticated by necessity: the recipient is a workshop
   * customer with a WhatsApp account and nothing else. The token is the whole
   * credential, which is why it is 256 bits of `randomBytes`, stored only as a
   * SHA-256 hash, scoped to one request, and expired by
   * `DPDP_EXPORT_TTL_HOURS`.
   *
   * The response is the bytes with `Content-Disposition: attachment`, and the
   * archive filename carries the pseudonym rather than the customer's name —
   * a file called `serviceloop-export-ramesh-kumar.zip` sitting in a phone's
   * Downloads folder is a small privacy leak to everyone who borrows the phone.
   */
  @Public()
  @Get('download')
  @Header('cache-control', 'no-store')
  async download(
    @ZodQuery(z.object({ token: z.string().min(20).max(200) })) query: { token: string },
    @Res() response: Response,
  ): Promise<void> {
    const archive = await this.service.download(query.token);
    response
      .status(200)
      .type('application/zip')
      .setHeader('content-disposition', `attachment; filename="${archive.filename}"`);
    response.send(archive.bytes);
  }
}
