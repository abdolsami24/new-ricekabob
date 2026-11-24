import Link from "next/link";
import { getDbMenu } from "@/lib/menuDb";
import { getDishPhotos, listPromotions } from "@/lib/admin";
import { formatCents } from "@/lib/menu";

// Deals: the active promotions managed from /admin.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Deals — Madinah Bakery & Kabob",
  description: "Current deals and promotions at Madinah Bakery & Kabob, Aurora, CO.",
};

export default async function DealsPage() {
  const [menu, photos, promos] = await Promise.all([
    getDbMenu(),
    getDishPhotos(),
    listPromotions(true),
  ]);
  const byId = Object.fromEntries(menu.items.map((m) => [m.id, m]));

  return (
    <main className="wrap">
      <h2 className="category-title">🎁 Deals &amp; promotions</h2>
      {promos.length === 0 ? (
        <div className="panel">
          <p>
            No special deals right now — but our everyday prices are hard to beat:
            platters from $11.75 and sandwiches from $8.99.
          </p>
          <p>
            <Link href="/menu">Browse the full menu →</Link>
          </p>
        </div>
      ) : (
        promos.map((p) => {
          const dish = p.item_id ? byId[p.item_id] : null;
          return (
            <div className="promo-box big" key={p.id}>
              {dish && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photos[dish.id] ?? dish.image} alt={dish.name} />
              )}
              <div className="promo-text">
                <strong>🎁 {p.title}</strong>
                {p.body && <span>{p.body}</span>}
                {dish && (
                  <span className="promo-dish">
                    {dish.name} · {formatCents(dish.price_cents)} ·{" "}
                    <Link href="/menu">Order it →</Link>
                  </span>
                )}
              </div>
            </div>
          );
        })
      )}
      <p className="home-more">
        ⭐ Signed-in customers also earn loyalty points on every paid order —{" "}
        <Link href="/rewards">see how Rewards work →</Link>
      </p>
    </main>
  );
}
