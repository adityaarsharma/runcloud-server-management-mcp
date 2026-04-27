/**
 * woocommerce.ts — WooCommerce-specific health audit
 *
 * Detects WC; if absent, returns a no-op. Otherwise reports: orphaned
 * sessions, expired transients, low-stock products, abandoned carts,
 * pending orders, and HPOS (High-Performance Order Storage) status.
 *
 * WP-CLI used:  wp wc (when wc-cli is installed) / wp db query / wp option get
 */

import { SSHOptions, wpCli } from '../../core/ssh-enhanced.js';

export interface WooCommerceAuditResult {
  installed: boolean;
  version: string | null;
  hposEnabled: boolean | null;
  orphanedSessions: number;
  expiredWcTransients: number;
  pendingOrders: number;
  failedOrders: number;
  abandonedCarts: number;
  lowStockProducts: number;
  outOfStockProducts: number;
  recommendations: string[];
}

function safe(p: string): void {
  if (/\.\./.test(p) || !p.startsWith('/')) throw new Error('invalid path');
}

async function tablePrefix(sshOpts: SSHOptions, wpPath: string, wpUser: string): Promise<string> {
  const r = await wpCli(sshOpts, wpPath, wpUser, `db prefix --skip-plugins --skip-themes 2>/dev/null`);
  return r.stdout.trim() || 'wp_';
}

export async function auditWooCommerce(
  sshOpts: SSHOptions, wpPath: string, wpUser: string,
): Promise<WooCommerceAuditResult> {
  safe(wpPath);

  // Detect: is WC active?
  const list = await wpCli(
    sshOpts, wpPath, wpUser,
    `plugin get woocommerce --field=status 2>/dev/null`,
  );
  if (!/active/.test(list.stdout)) {
    return {
      installed: false, version: null, hposEnabled: null,
      orphanedSessions: 0, expiredWcTransients: 0,
      pendingOrders: 0, failedOrders: 0, abandonedCarts: 0,
      lowStockProducts: 0, outOfStockProducts: 0,
      recommendations: ['WooCommerce not active — module not applicable.'],
    };
  }

  const verRes = await wpCli(sshOpts, wpPath, wpUser, `plugin get woocommerce --field=version 2>/dev/null`);
  const version = verRes.stdout.trim() || null;

  const px = await tablePrefix(sshOpts, wpPath, wpUser);

  // HPOS status
  const hposRes = await wpCli(
    sshOpts, wpPath, wpUser,
    `option get woocommerce_custom_orders_table_enabled 2>/dev/null`,
  );
  const hposEnabled = hposRes.stdout.trim() === 'yes';

  // Combined query for cheap stats
  const r = await wpCli(
    sshOpts, wpPath, wpUser,
    `db query "` +
    `SELECT 'sess', COUNT(*) FROM \`${px}woocommerce_sessions\` UNION ALL ` +
    `SELECT 'trans', COUNT(*) FROM \`${px}options\` WHERE option_name LIKE '_transient_wc_%' OR option_name LIKE '_transient_timeout_wc_%' UNION ALL ` +
    `SELECT 'pend', COUNT(*) FROM \`${px}posts\` WHERE post_type='shop_order' AND post_status='wc-pending' UNION ALL ` +
    `SELECT 'fail', COUNT(*) FROM \`${px}posts\` WHERE post_type='shop_order' AND post_status='wc-failed' UNION ALL ` +
    `SELECT 'cart', COUNT(*) FROM \`${px}woocommerce_sessions\` WHERE session_expiry < UNIX_TIMESTAMP() UNION ALL ` +
    `SELECT 'low', COUNT(*) FROM \`${px}postmeta\` pm JOIN \`${px}posts\` p ON p.ID=pm.post_id WHERE p.post_type='product' AND pm.meta_key='_stock' AND CAST(pm.meta_value AS UNSIGNED) BETWEEN 1 AND 5 UNION ALL ` +
    `SELECT 'oos', COUNT(*) FROM \`${px}postmeta\` pm JOIN \`${px}posts\` p ON p.ID=pm.post_id WHERE p.post_type='product' AND pm.meta_key='_stock_status' AND pm.meta_value='outofstock';" --skip-column-names 2>/dev/null`,
  );

  const m = new Map<string, number>();
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const parts = line.split(/\s+/);
    if (parts.length >= 2) m.set(parts[0], parseInt(parts[1], 10) || 0);
  }

  const orphanedSessions = m.get('sess') ?? 0;
  const expiredWcTransients = m.get('trans') ?? 0;
  const pendingOrders = m.get('pend') ?? 0;
  const failedOrders = m.get('fail') ?? 0;
  const abandonedCarts = m.get('cart') ?? 0;
  const lowStockProducts = m.get('low') ?? 0;
  const outOfStockProducts = m.get('oos') ?? 0;

  const recommendations: string[] = [];
  if (orphanedSessions > 1000) {
    recommendations.push(
      `${orphanedSessions} WC session rows — clear with 'wp wc tool run clear_sessions' or wp.db_clean.`,
    );
  }
  if (expiredWcTransients > 500) {
    recommendations.push(
      `${expiredWcTransients} expired WC transients — purge via wp.db_clean (cleanTransients).`,
    );
  }
  if (failedOrders > 50) {
    recommendations.push(`${failedOrders} failed orders — investigate payment gateway logs.`);
  }
  if (pendingOrders > 100) {
    recommendations.push(`${pendingOrders} pending orders — long pending queue often means abandoned checkouts.`);
  }
  if (lowStockProducts > 0) {
    recommendations.push(`${lowStockProducts} product(s) low on stock (≤5).`);
  }
  if (!hposEnabled) {
    recommendations.push(
      'High-Performance Order Storage (HPOS) is not enabled. WC 8.2+ recommends HPOS for sites with >5K orders. Enable in WC → Settings → Advanced → Features.',
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('WooCommerce health looks good.');
  }

  return {
    installed: true, version, hposEnabled,
    orphanedSessions, expiredWcTransients,
    pendingOrders, failedOrders, abandonedCarts,
    lowStockProducts, outOfStockProducts,
    recommendations,
  };
}
