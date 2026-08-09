/**
 * The real deposit path, through Gravv.
 *
 * Shapes here were established against the live sandbox rather than read off the docs,
 * because three of them are not what the docs imply:
 *
 *  - `createCustomer` wraps its fields in a `body` object. Sending them flat fails with
 *    a bare "EOF".
 *  - The collection's country comes from the **customer record**, not the request. With
 *    a customer that has no address you get "payment method 'card' is not available for
 *    country ''" no matter what `country` you pass.
 *  - `getCollection` currently fails through the MCP with "x-tenant-id is missing", so
 *    confirmation falls back to the transaction list. Gravv's collections webhook is
 *    the durable answer; see README.
 */

import Decimal from 'decimal.js';

import type { Config } from './config.js';
import { GravvError, GravvMcp } from './gravvMcp.js';
import type { CollectDepositInput } from './schemas.js';
import type { Checkout, PaymentBackend, PaymentRecord } from './service.js';
import type { DepositStatus } from './schemas.js';

/** Gravv's onramp states, mapped to the three the orchestrator cares about. */
const PAID = new Set(['completed', 'settled', 'success', 'successful', 'paid']);
const DEAD = new Set(['failed', 'cancelled', 'canceled', 'expired', 'rejected']);

interface CustomerResponse {
  id: string;
  status?: string;
}

interface CollectionResponse {
  transaction_id?: string;
  payment_link?: string;
  raw_payment_link?: string;
  onramp_status?: string;
  country?: string;
  amount?: string;
  currency?: string;
}

export class GravvBackend implements PaymentBackend {
  /** CODLOCK customer id -> Gravv customer uuid, so we create each person once. */
  private readonly customers = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly mcp: GravvMcp = new GravvMcp(config),
  ) {
    if (!config.gravvSellerAccountId) {
      throw new Error(
        'GRAVV_SELLER_ACCOUNT_ID is not set. Run `listAccounts` against the sandbox ' +
          'and use the account the deposit should land in.',
      );
    }
  }

  async openCheckout(request: CollectDepositInput): Promise<Checkout> {
    const customerId = await this.ensureCustomer(request);
    const settlement = this.toSettlementAmount(request.deposit.amount);

    const collection = await this.mcp.call<CollectionResponse>('createCollection', {
      amount: settlement,
      currency: this.config.settlementCurrency,
      country: this.config.customerCountry,
      customer_id: customerId,
      client_customer_id: request.customer.customer_id,
      client_reference: request.order_id,
      source: { source_type: 'external', methods: ['card'] },
      destination: {
        destination_type: 'internal_account',
        id: this.config.gravvSellerAccountId,
      },
      // Gravv previews money-moving calls and executes only on the second, confirmed
      // one. We are not a chat agent asking a human — the deposit was already decided
      // upstream by risk scoring, so we confirm deliberately here.
      confirm: true,
    });

    if (!collection.payment_link) {
      throw new GravvError(
        'createCollection',
        null,
        'Gravv created the collection but returned no payment_link.',
      );
    }

    return {
      checkoutUrl: collection.payment_link,
      refs: {
        seller_account_id: this.config.gravvSellerAccountId ?? null,
        seller_customer_id: customerId,
        collection_id: collection.transaction_id ?? null,
        payment_link_id: null,
        settlement: {
          amount: settlement,
          currency: this.config.settlementCurrency,
        },
        environment: this.config.gravvAllowLiveWrites ? 'live' : 'sandbox',
      },
    };
  }

  async pollStatus(record: PaymentRecord): Promise<DepositStatus> {
    if (record.expiresAt && Date.now() > record.expiresAt.getTime()) return 'expired';

    const collectionId = record.gravv.collection_id;
    if (collectionId) {
      try {
        const current = await this.mcp.call<CollectionResponse>('getCollection', {
          id: collectionId,
        });
        const mapped = mapStatus(current.onramp_status);
        if (mapped) return mapped;
      } catch (error) {
        // getCollection is presently broken through the MCP. Fall through rather than
        // failing the poll — an unconfirmed deposit is not a failed one.
        if (!(error instanceof GravvError)) throw error;
      }
    }

    return (await this.seenInTransactions(record.orderId))
      ? 'paid'
      : 'awaiting_payment';
  }

  /** Fallback confirmation: the settled transaction carries our client_reference. */
  private async seenInTransactions(orderId: string): Promise<boolean> {
    try {
      const page = await this.mcp.call<{ items?: { client_reference?: string }[] }>(
        'listTransactions',
        {},
      );
      return (page.items ?? []).some((item) => item.client_reference === orderId);
    } catch {
      return false;
    }
  }

  /** Create the Gravv customer once per person; the country lives on this record. */
  private async ensureCustomer(request: CollectDepositInput): Promise<string> {
    const cached = this.customers.get(request.customer.customer_id);
    if (cached) return cached;

    const [firstName, ...rest] = request.customer.full_name.trim().split(/\s+/);
    const created = await this.mcp.call<CustomerResponse>('createCustomer', {
      body: {
        first_name: firstName || request.customer.customer_id,
        last_name: rest.join(' ') || 'Customer',
        email:
          request.customer.email ??
          `${request.customer.customer_id.toLowerCase()}@codlock.invalid`,
        phone: request.customer.phone,
        type: 'individual',
        gender: 'other',
        date_of_birth: '1995-01-01',
        address: {
          address_line1: request.customer.zone ?? 'Tunis',
          city: request.customer.zone ?? 'Tunis',
          country: this.config.customerCountry,
          postal_code: '1000',
          state: 'TN-11',
        },
      },
    });

    this.customers.set(request.customer.customer_id, created.id);
    return created.id;
  }

  /**
   * Orders are priced in TND; Gravv settles in stablecoin and quotes cards in USD.
   * The customer still sees TND everywhere — this is only what Gravv is asked for.
   */
  private toSettlementAmount(tnd: string): string {
    if (this.config.settlementCurrency === 'TND') return new Decimal(tnd).toFixed(2);
    return new Decimal(tnd).div(this.config.tndPerSettlementUnit).toFixed(2);
  }
}

function mapStatus(onrampStatus: string | undefined): DepositStatus | null {
  if (!onrampStatus) return null;
  const status = onrampStatus.toLowerCase();
  if (PAID.has(status)) return 'paid';
  if (DEAD.has(status)) return 'failed';
  return 'awaiting_payment';
}
