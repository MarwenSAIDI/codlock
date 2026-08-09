import { ServiceUnavailableException } from '@nestjs/common';
import { Channel, RiskTier } from '../../common/enums';
import { RiskService } from './risk.service';

/**
 * The deposit a customer is asked for is decided entirely here, so the tier
 * boundaries and the degraded-mode fallback are pinned explicitly.
 */
describe('RiskService', () => {
  const sellerId = '11111111-1111-4111-8111-111111111111';
  const customerId = '44444444-4444-4444-8444-444444444444';

  const rates = { trusted: 0, medium: 0.1, high: 0.2 };
  const thresholds = { high: 70, medium: 40 };

  let orchestrator: { scoreRisk: jest.Mock };
  let customers: { findOneForSeller: jest.Mock };
  let firebase: { logEvent: jest.Mock };
  let service: RiskService;

  const customer = (overrides: Record<string, unknown> = {}) => ({
    id: customerId,
    phone: '+21620123456',
    zone: 'Sfax',
    total_orders: 10,
    successful_orders: 9,
    refused_orders: 1,
    ...overrides,
  });

  const build = () => {
    const config = {
      get: jest.fn((key: string) =>
        key === 'risk.depositRates' ? rates : thresholds,
      ),
    };
    return new RiskService(
      orchestrator as never,
      customers as never,
      firebase as never,
      config as never,
    );
  };

  beforeEach(() => {
    orchestrator = { scoreRisk: jest.fn() };
    customers = { findOneForSeller: jest.fn() };
    firebase = { logEvent: jest.fn() };
    customers.findOneForSeller.mockResolvedValue(customer());
    service = build();
  });

  const evaluate = (orderValue = 100) =>
    service.evaluate(sellerId, {
      customerId,
      orderValue,
      channel: Channel.INSTAGRAM,
    });

  describe('tier boundaries', () => {
    it.each([
      [0, RiskTier.TRUSTED, 0],
      [39, RiskTier.TRUSTED, 0],
      // 40 is the medium threshold and is inclusive.
      [40, RiskTier.MEDIUM, 0.1],
      [69, RiskTier.MEDIUM, 0.1],
      // 70 is the high threshold and is inclusive.
      [70, RiskTier.HIGH, 0.2],
      [100, RiskTier.HIGH, 0.2],
    ])('scores %i as %s at rate %f', async (score, tier, depositRate) => {
      orchestrator.scoreRisk.mockResolvedValue({ score });

      const result = await evaluate(200);

      expect(result.tier).toBe(tier);
      expect(result.depositRate).toBe(depositRate);
      expect(result.depositAmount).toBe(
        Math.round(200 * depositRate * 100) / 100,
      );
    });

    it('clamps an out-of-range remote score into 0–100', async () => {
      orchestrator.scoreRisk.mockResolvedValue({ score: 512 });
      await expect(evaluate()).resolves.toMatchObject({ score: 100 });

      orchestrator.scoreRisk.mockResolvedValue({ score: -12 });
      await expect(evaluate()).resolves.toMatchObject({ score: 0 });
    });

    it('rounds a fractional remote score before tiering', async () => {
      orchestrator.scoreRisk.mockResolvedValue({ score: 39.6 });
      await expect(evaluate()).resolves.toMatchObject({
        score: 40,
        tier: RiskTier.MEDIUM,
      });
    });
  });

  describe('deposit amount', () => {
    it('rounds to two decimals', async () => {
      orchestrator.scoreRisk.mockResolvedValue({ score: 50 });
      await expect(evaluate(33.33)).resolves.toMatchObject({
        depositAmount: 3.33,
      });
    });

    it('charges nothing for a trusted buyer', async () => {
      orchestrator.scoreRisk.mockResolvedValue({ score: 5 });
      await expect(evaluate(500)).resolves.toMatchObject({
        tier: RiskTier.TRUSTED,
        depositAmount: 0,
      });
    });
  });

  describe('degraded mode', () => {
    beforeEach(() => {
      orchestrator.scoreRisk.mockRejectedValue(
        new ServiceUnavailableException('circuit open'),
      );
    });

    it('treats a first-time buyer as elevated risk rather than trusted', async () => {
      customers.findOneForSeller.mockResolvedValue(
        customer({ total_orders: 0, successful_orders: 0, refused_orders: 0 }),
      );

      const result = await evaluate(100);

      expect(result.score).toBe(65);
      expect(result.tier).toBe(RiskTier.MEDIUM);
      expect(result.factors).toEqual({ fallback: true });
    });

    it('derives the score from the refusal rate of known buyers', async () => {
      customers.findOneForSeller.mockResolvedValue(
        customer({ total_orders: 10, refused_orders: 8 }),
      );

      await expect(evaluate(100)).resolves.toMatchObject({
        score: 80,
        tier: RiskTier.HIGH,
        depositAmount: 20,
      });
    });

    it('does not charge a spotless repeat buyer', async () => {
      customers.findOneForSeller.mockResolvedValue(
        customer({ total_orders: 12, refused_orders: 0 }),
      );

      await expect(evaluate(100)).resolves.toMatchObject({
        score: 0,
        tier: RiskTier.TRUSTED,
        depositAmount: 0,
      });
    });

    it('marks the result so callers can tell it was not the real engine', async () => {
      await expect(evaluate()).resolves.toMatchObject({
        factors: { fallback: true },
      });
    });
  });

  it('propagates a missing customer instead of scoring a stranger', async () => {
    customers.findOneForSeller.mockRejectedValue(
      new Error('Customer not found'),
    );
    await expect(evaluate()).rejects.toThrow('Customer not found');
    expect(orchestrator.scoreRisk).not.toHaveBeenCalled();
  });
});
