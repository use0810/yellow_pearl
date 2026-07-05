import { findShippingRegion, getShippingRegionsFromMap, PRODUCT_ID } from '../../../shared/domain.js';
import { json } from './http.js';
import { fetchInventoryRow, getShippingMap, inventoryPublicFields } from './inventory.js';
import { isStripeEnabledForMode, normalizeStripeMode } from './stripe.js';

export async function handleAdminInventoryUpdate(request, env, CORS) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON' }, 400, CORS);

  const stock = parseInt(body.stock, 10);
  const unitPrice = parseInt(body.unit_price, 10);
  const taxRate = parseInt(body.tax_rate, 10);
  if (isNaN(stock) || stock < 0) {
    return json({ error: '在庫数の値が不正です' }, 400, CORS);
  }
  if (isNaN(unitPrice) || unitPrice < 0) {
    return json({ error: '単価の値が不正です' }, 400, CORS);
  }
  if (unitPrice === 0 && !body.sold_out && stock > 0) {
    return json({ error: '単価は1円以上で設定してください' }, 400, CORS);
  }
  if (isNaN(taxRate) || taxRate < 0 || taxRate > 100) {
    return json({ error: '税率の値が不正です' }, 400, CORS);
  }

  const soldOut = body.sold_out ? 1 : (stock <= 0 ? 1 : 0);

  await env.DB.prepare(
    `UPDATE inventory SET stock = ?, sold_out = ?, unit_price = ?, tax_rate = ? WHERE product_id = ?`
  ).bind(stock, soldOut, unitPrice, taxRate, PRODUCT_ID).run();

  return json({ stock, sold_out: soldOut === 1, unit_price: unitPrice, tax_rate: taxRate }, 200, CORS);
}

export async function handleAdminShippingUpdate(request, env, CORS) {
  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.rates)) {
    return json({ error: '送料データが不正です' }, 400, CORS);
  }

  const updates = [];
  for (const item of body.rates) {
    const region = findShippingRegion(item.region);
    if (!region) {
      return json({ error: `不正な地域: ${item.region}` }, 400, CORS);
    }
    const fee = parseInt(item.fee, 10);
    if (isNaN(fee) || fee < 0) {
      return json({ error: `${region.name} の送料が不正です` }, 400, CORS);
    }
    for (const prefecture of region.prefectures) {
      updates.push({ prefecture, fee });
    }
  }

  let shippingTaxRate = 10;
  if (body.shipping_tax_rate !== undefined) {
    shippingTaxRate = parseInt(body.shipping_tax_rate, 10);
    if (Number.isNaN(shippingTaxRate) || shippingTaxRate < 0 || shippingTaxRate > 100) {
      return json({ error: '送料の消費税率が不正です' }, 400, CORS);
    }
  } else {
    const inv = await env.DB.prepare(
      'SELECT shipping_tax_rate FROM inventory WHERE product_id = ?'
    ).bind(PRODUCT_ID).first();
    shippingTaxRate = inv?.shipping_tax_rate ?? 10;
  }

  const stmts = updates.map(({ prefecture, fee }) =>
    env.DB.prepare(
      `INSERT INTO shipping_rates (prefecture, fee) VALUES (?, ?)
       ON CONFLICT(prefecture) DO UPDATE SET fee = excluded.fee`
    ).bind(prefecture, fee)
  );

  if (stmts.length) await env.DB.batch(stmts);

  if (body.shipping_tax_rate !== undefined) {
    await env.DB.prepare(
      `UPDATE inventory SET shipping_tax_rate = ? WHERE product_id = ?`
    ).bind(shippingTaxRate, PRODUCT_ID).run();
  }

  const shippingMap = await getShippingMap(env.DB);
  return json({
    shipping_regions: getShippingRegionsFromMap(shippingMap),
    shipping_tax_rate: shippingTaxRate,
  }, 200, CORS);
}

export async function handleAdminStripeModeUpdate(request, env, CORS) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Invalid JSON' }, 400, CORS);

  const stripeMode = normalizeStripeMode(body.stripe_mode);
  if (stripeMode === 'live' && !isStripeEnabledForMode(env, 'live')) {
    return json({
      error: '本番用 Stripe キー（STRIPE_SECRET_KEY_LIVE）が Worker に設定されていません',
    }, 400, CORS);
  }
  if (stripeMode === 'test' && !isStripeEnabledForMode(env, 'test')) {
    return json({
      error: 'テスト用 Stripe キー（STRIPE_SECRET_KEY）が Worker に設定されていません',
    }, 400, CORS);
  }

  await env.DB.prepare(
    `UPDATE inventory SET stripe_mode = ? WHERE product_id = ?`
  ).bind(stripeMode, PRODUCT_ID).run();

  const inv = await fetchInventoryRow(env.DB);
  return json({
    inventory: inventoryPublicFields(inv, env),
  }, 200, CORS);
}
