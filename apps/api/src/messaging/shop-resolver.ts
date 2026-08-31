import { Inject, Injectable } from '@nestjs/common';
import { PgShopDirectory, type PgUnitOfWork, type Tx } from '@serviceloop/db';
import { NotFoundError } from '@serviceloop/shared';
import { UNIT_OF_WORK } from '../infra/tokens';

/**
 * Which shop a webhook delivery belongs to.
 *
 * One webhook URL serves every tenant, so the delivery has to identify its
 * shop, and the only stable thing in a Meta payload that does is
 * `metadata.phone_number_id`. Nothing else in the body is trusted for this: the
 * body is attacker-supplied until the signature has been checked, and a
 * spoofable shop id would be a cross-tenant write into somebody else's
 * conversations.
 *
 * The single-shop fallback exists for the sandbox and single-tenant dev, where
 * there is no Meta to have registered a number with — and it is deliberately
 * *sole*-shop rather than first-shop, so it cannot silently pick a tenant on an
 * installation that has grown a second one.
 */
@Injectable()
export class ShopResolver {
  private readonly directory = new PgShopDirectory();

  constructor(@Inject(UNIT_OF_WORK) private readonly uow: PgUnitOfWork) {}

  async resolve(phoneNumberId: string | null): Promise<string> {
    const shopId = await this.uow.transaction(async (tx: Tx) => {
      if (phoneNumberId !== null) {
        const byNumber = await this.directory.findShopByPhoneNumberId(tx, phoneNumberId);
        if (byNumber !== null) return byNumber;
      }
      return this.directory.soleShopId(tx);
    });

    if (shopId === null) {
      throw new NotFoundError(
        'Shop',
        phoneNumberId ?? 'unknown phone number id',
      );
    }
    return shopId;
  }
}
