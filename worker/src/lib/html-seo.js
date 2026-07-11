import { calcOrderAmount } from '../../../shared/domain.js';
import { fetchInventoryRow } from './inventory.js';

const INDEX_PATHS = new Set(['/', '/index.html']);

/** Google Product スニペット用: 税込・1本あたり（送料なし） */
export function unitPriceInclFromInventory(row) {
  const unitPrice = Number(row?.unit_price ?? 0);
  const taxRate = Number(row?.tax_rate ?? 0);
  if (unitPrice <= 0) return 0;
  const { totalAmount } = calcOrderAmount(unitPrice, 1, taxRate, 0, 0);
  return totalAmount;
}

export function productAvailability(row) {
  const stock = Number(row?.stock ?? 0);
  if (row?.sold_out || stock <= 0) {
    return 'https://schema.org/OutOfStock';
  }
  return 'https://schema.org/PreOrder';
}

/**
 * index.html の Product offers に DB 価格を埋め込む。
 * 静的 HTML には price を書かず、ここでのみ注入する（Googlebot が初期 HTML を読める）。
 */
export function injectProductStructuredData(html, { priceIncl, availability }) {
  let out = html;

  if (priceIncl > 0 && !/"price"\s*:/.test(out)) {
    out = out.replace(
      '"priceCurrency": "JPY"',
      `"price": "${priceIncl}",\n              "priceCurrency": "JPY"`,
    );
  }

  if (availability) {
    out = out.replace(
      /https:\/\/schema\.org\/(PreOrder|InStock|OutOfStock)/,
      availability,
    );
  }

  return out;
}

export function isIndexHtmlPath(pathname) {
  return INDEX_PATHS.has(pathname);
}

/** Pages オリジンの index を取得し、在庫の税込単価を JSON-LD に注入して返す */
export async function handleIndexHtml(request, env) {
  const originRes = await fetch(request);
  const contentType = originRes.headers.get('content-type') || '';
  if (!originRes.ok || !contentType.includes('text/html') || !env.DB) {
    return originRes;
  }

  let priceIncl = 0;
  let availability = 'https://schema.org/PreOrder';
  try {
    const row = await fetchInventoryRow(env.DB);
    priceIncl = unitPriceInclFromInventory(row);
    availability = productAvailability(row);
  } catch {
    // DB 失敗時は静的 HTML のまま返す
  }

  const html = await originRes.text();
  const body = injectProductStructuredData(html, { priceIncl, availability });

  const headers = new Headers(originRes.headers);
  headers.set('Cache-Control', 'public, max-age=300');
  headers.delete('content-length');

  return new Response(body, {
    status: originRes.status,
    statusText: originRes.statusText,
    headers,
  });
}
