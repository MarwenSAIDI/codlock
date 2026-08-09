import { GravvEventType } from '../../common/enums';
import { PaymentsService } from './payments.service';

describe('PaymentsService webhook processing', () => {
  it('passes the provider event identity and expected money fields to the atomic RPC', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: { orderId: 'order-1', applied: 'DEPOSIT_PAID', duplicate: false },
      error: null,
    });
    const service = new PaymentsService({} as any, { client: { rpc } } as any);

    const result = await service.processWebhook({
      eventId: 'evt-1',
      event: GravvEventType.PAYMENT_SUCCEEDED,
      paymentId: 'pay-1',
      amount: 29.8,
      currency: 'tnd',
    });

    expect(rpc).toHaveBeenCalledWith('process_gravv_webhook', {
      p_event_id: 'evt-1',
      p_event_type: GravvEventType.PAYMENT_SUCCEEDED,
      p_payment_id: 'pay-1',
      p_amount: 29.8,
      p_currency: 'TND',
    });
    expect(result.duplicate).toBe(false);
  });
});
