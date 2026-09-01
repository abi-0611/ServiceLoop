import { Module } from '@nestjs/common';
import { CostsController } from './costs.controller';
import { TemplatesController } from './templates.controller';

/**
 * The channel-operations surface (phase 7.3).
 *
 * Controllers only, and both of them read. Everything they need is either pure
 * (`TEMPLATE_MANIFEST` and the lint), configuration (`WA_PRICING_JSON`, the
 * shop's DLT map) or a table with a store that takes a transaction — so there
 * is no runtime to provide and nothing here for another module to import.
 *
 * Kept apart from `RetentionModule` even though the console shows cost beside
 * the other analytics, because the two answer to different clocks and different
 * sources of truth: an analytics KPI is a fold of this shop's own event log,
 * and a cost is what a third party will invoice. Merging them would put a
 * number Meta decides into a controller whose stated invariant is that it only
 * ever reads a stored rollup.
 */
@Module({
  controllers: [TemplatesController, CostsController],
})
export class OpsModule {}
