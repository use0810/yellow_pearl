/**
 * ヤマト運輸 B2クラウド「送り状発行データレイアウト（基本レイアウト）」の CSV を組む。
 * 全 97 列を必ず出し、埋めない列は空文字にする。列の順番が仕様なので入れ替えないこと。
 */

import { B2_DELIVERY_TIMES } from '../../../shared/domain.js';

/** B2クラウド側で選ぶ運用にする列（請求先顧客コードなど）は空にしておく */
const COLUMNS = [
  'お客様管理番号',
  '送り状種類',
  'クール区分',
  '伝票番号',
  '出荷予定日',
  'お届け予定（指定）日',
  '配達時間帯',
  'お届け先コード',
  'お届け先電話番号',
  'お届け先電話番号枝番',
  'お届け先郵便番号',
  'お届け先住所',
  'お届け先住所（アパートマンション名）',
  'お届け先会社・部門名１',
  'お届け先会社・部門名２',
  'お届け先名',
  'お届け先名略称カナ',
  '敬称',
  'ご依頼主コード',
  'ご依頼主電話番号',
  'ご依頼主電話番号枝番',
  'ご依頼主郵便番号',
  'ご依頼主住所',
  'ご依頼主住所（アパートマンション名）',
  'ご依頼主名',
  'ご依頼主略称カナ',
  '品名コード１',
  '品名１',
  '品名コード２',
  '品名２',
  '荷扱い１',
  '荷扱い２',
  '記事',
  'コレクト代金引換額（税込）',
  'コレクト内消費税額等',
  '営業所止置き',
  '営業所コード',
  '発行枚数',
  '個数口枠の印字',
  'ご請求先顧客コード',
  'ご請求先分類コード',
  '運賃管理番号',
  'クロネコwebコレクトデータ登録',
  'クロネコwebコレクト加盟店番号',
  'クロネコwebコレクト申込受付番号１',
  'クロネコwebコレクト申込受付番号２',
  'クロネコwebコレクト申込受付番号３',
  'お届け予定ｅメール利用区分',
  'お届け予定ｅメールe-mailアドレス',
  '入力機種',
  'お届け予定eメールメッセージ',
  'お届け完了eメール利用区分',
  'お届け完了ｅメールe-mailアドレス',
  'お届け完了eメールメッセージ',
  'クロネコ収納代行利用区分',
  '予備',
  '収納代行請求金額(税込)',
  '収納代行内消費税額等',
  '収納代行請求先郵便番号',
  '収納代行請求先住所',
  '収納代行請求先住所（アパートマンション名）',
  '収納代行請求先会社・部門名１',
  '収納代行請求先会社・部門名２',
  '収納代行請求先名(漢字)',
  '収納代行請求先名(カナ)',
  '収納代行問合せ先名(漢字)',
  '収納代行問合せ先郵便番号',
  '収納代行問合せ先住所',
  '収納代行問合せ先住所（アパートマンション名）',
  '収納代行問合せ先電話番号',
  '収納代行管理番号',
  '収納代行品名',
  '収納代行備考',
  '複数口くくりキー',
  '検索キータイトル１',
  '検索キー１',
  '検索キータイトル２',
  '検索キー２',
  '検索キータイトル3',
  '検索キー3',
  '検索キータイトル４',
  '検索キー４',
  '検索キータイトル5',
  '検索キー5',
  '予備',
  '予備',
  '投函予定メール利用区分',
  '投函予定メールe-mailアドレス',
  '投函予定メールメッセージ',
  '投函完了メール（お届け先宛）利用区分',
  '投函完了メール（お届け先宛）e-mailアドレス',
  '投函完了メール（お届け先宛）メールメッセージ',
  '投函完了メール（ご依頼主宛）利用区分',
  '投函完了メール（ご依頼主宛）e-mailアドレス',
  '投函完了メール（ご依頼主宛）メールメッセージ',
  '連携管理番号',
  '通知メールアドレス',
];

/** 値を入れる列（1-based の列番号。レイアウト仕様の番号と同じ） */
const COL = Object.freeze({
  管理番号: 1,
  送り状種類: 2,
  クール区分: 3,
  出荷予定日: 5,
  配達時間帯: 7,
  届け先電話: 9,
  届け先郵便番号: 11,
  届け先住所: 12,
  届け先建物名: 13,
  届け先名: 16,
  届け先名カナ: 17,
  敬称: 18,
  依頼主電話: 20,
  依頼主郵便番号: 22,
  依頼主住所: 23,
  依頼主名: 25,
  品名1: 28,
  発行枚数: 38,
  お届け予定メール: 48,
  お届け完了メール: 52,
});

/** 宅急便の発払い・クール冷蔵 */
const INVOICE_TYPE = '0';
const COOL_TYPE = '2';

/** ご依頼主。特定商取引法に基づく表記（tokusho.html）と揃える */
const SENDER = {
  phone: '050-8893-2144',
  postal: '039-1801',
  address: '青森県三戸郡新郷村大字戸来字早坂2-1',
  name: '新郷村郷のきみの会',
};

/** 品名は 25 文字まで。正式名は長いので送り状用の短縮名を使う */
const LABEL_PRODUCT_NAME = '郷のきみイエローパール';

/** B2クラウドが受け付けない環境依存文字（ローマ数字・丸数字・省略文字・単位など） */
const ENV_DEPENDENT = /[\u2116\u2121\u2160-\u217F\u2460-\u24FF\u3220-\u3243\u3280-\u32FF\u3300-\u33FF]/;

const HALF_DAKUTEN = '\uFF9E';
const HALF_HANDAKUTEN = '\uFF9F';
const VOICED = 'ガギグゲゴザジズゼゾダヂヅデドバビブベボヴ';
const SEMI_VOICED = 'パピプペポ';
const FULL_KANA = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンァィゥェォッャュョー・';
const HALF_KANA = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝｧｨｩｪｫｯｬｭｮｰ･';

/** 濁点・半濁点つきは清音に戻してから半角の濁点記号を足す */
function kanaChar(ch) {
  if (ch === 'ヴ') return `${kanaChar('ウ')}${HALF_DAKUTEN}`;
  if (VOICED.includes(ch)) {
    const base = String.fromCharCode(ch.charCodeAt(0) - 1);
    return `${kanaChar(base)}${HALF_DAKUTEN}`;
  }
  if (SEMI_VOICED.includes(ch)) {
    const base = String.fromCharCode(ch.charCodeAt(0) - 2);
    return `${kanaChar(base)}${HALF_HANDAKUTEN}`;
  }
  const i = FULL_KANA.indexOf(ch);
  return i >= 0 ? HALF_KANA[i] : ch;
}

export function toHalfWidthKana(input) {
  return String(input ?? '').split('').map(kanaChar).join('');
}

export function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** B2クラウドは全角スペースや連続スペースが混ざると住所を取り込めないことがある */
function cleanText(value) {
  return String(value ?? '').replace(/[\u3000\s]+/g, ' ').trim();
}

/** YYYY-MM-DD / YYYY/MM/DD どちらでも受け、B2 の YYYY/MM/DD にそろえる */
export function normalizeShipDate(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}/${pad(month)}/${pad(day)}`;
}

/** 出荷予定日を省略したときの既定値（JST の当日） */
export function todayShipDate() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return normalizeShipDate(jst.toISOString().slice(0, 10));
}

const B2_DELIVERY_TIME_CODES = new Set(B2_DELIVERY_TIMES.map((t) => t.value));

/** B2 の配達時間帯コード。未指定・不正は空（指定なし） */
export function normalizeDeliveryTime(raw) {
  const code = String(raw ?? '').trim();
  return B2_DELIVERY_TIME_CODES.has(code) ? code : '';
}

function buildRow(order, shipDate, deliveryTime) {
  const row = new Array(COLUMNS.length).fill('');
  const set = (col, value) => { row[col - 1] = value; };

  set(COL.管理番号, order.order_id);
  set(COL.送り状種類, INVOICE_TYPE);
  set(COL.クール区分, COOL_TYPE);
  set(COL.出荷予定日, shipDate);
  set(COL.配達時間帯, deliveryTime);

  set(COL.届け先電話, cleanText(order.phone));
  set(COL.届け先郵便番号, cleanText(order.postal));
  set(COL.届け先住所, cleanText(`${order.prefecture ?? ''}${order.address1 ?? ''}`));
  set(COL.届け先建物名, cleanText(order.address2));
  set(COL.届け先名, cleanText(`${order.last_name ?? ''} ${order.first_name ?? ''}`));
  set(
    COL.届け先名カナ,
    toHalfWidthKana(cleanText(`${order.last_name_kana ?? ''} ${order.first_name_kana ?? ''}`)),
  );
  set(COL.敬称, '様');

  set(COL.依頼主電話, SENDER.phone);
  set(COL.依頼主郵便番号, SENDER.postal);
  set(COL.依頼主住所, SENDER.address);
  set(COL.依頼主名, SENDER.name);

  set(COL.品名1, `${LABEL_PRODUCT_NAME} ${order.quantity ?? 1}本`);
  set(COL.発行枚数, '1');
  set(COL.お届け予定メール, '0');
  set(COL.お届け完了メール, '0');

  return row.map(csvEscape).join(',');
}

/**
 * 取り込めない文字や欠けている項目を拾う。
 * 発行は止めず、管理画面で直してから出し直せるように警告として返す。
 */
export function findShippingLabelWarnings(orders) {
  const warnings = [];
  for (const o of orders) {
    const fields = [
      ['お名前', `${o.last_name ?? ''}${o.first_name ?? ''}`],
      ['住所', `${o.prefecture ?? ''}${o.address1 ?? ''}${o.address2 ?? ''}`],
    ];
    for (const [label, value] of fields) {
      if (ENV_DEPENDENT.test(value)) {
        warnings.push(`${o.order_id}: ${label}に環境依存文字（丸数字・ローマ数字など）が含まれます`);
      }
    }
    if (!o.postal || !o.phone || !o.address1) {
      warnings.push(`${o.order_id}: 郵便番号・電話番号・住所のいずれかが空です`);
    }
  }
  return warnings;
}

/** ヘッダー行つき・CRLF・UTF-8 BOM。B2 側の取込開始行は 2 行目にする */
export function buildShippingLabelCsv(orders, shipDate) {
  const lines = [
    COLUMNS.map(csvEscape).join(','),
    ...orders.map((o) => buildRow(o, shipDate, normalizeDeliveryTime(o.delivery_time))),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function shippingLabelFilename(shipDate, batchId) {
  return `yellow-pearl-b2-${shipDate.replace(/\//g, '')}-${batchId}.csv`;
}
