import Link from "next/link";
import { getDbMenu } from "@/lib/menuDb";
import {
  getDishPhotos,
  getHoursConfig,
  listPromotions,
  HERO_PHOTO_ID,
  HERO_VIDEO_ID,
} from "@/lib/admin";
import { formatCents, type MenuItem } from "@/lib/menu";
import {
  pickupWindows,
  deliveryWindows,
  formatWindow,
} from "@/lib/hours";

// Home page, mirroring madinah.boyscoding.com: stage-green hero with a
// signature dish photo, Deals for you, "How would you like it?", Guest
// favorites, Popular right now, Explore the menu, a rewards band and
// Visit us — all on the warm cream canvas.
export const dynamic = "force-dynamic";

// Hand-picked sections (ids from lib/menu.ts).
const GUEST_FAVORITES = ["kobideh-kabob", "lamb-gyro-rice", "chicken-shawarma-sandwich", "falafel-platter"];
const POPULAR_NOW = ["combo-platter", "sultani-kabob", "lamb-shank", "chicken-tikka-kabob"];

export default async function HomePage() {
  const [menu, photos, hours, promos] = await Promise.all([
    getDbMenu(),
    getDishPhotos(),
    getHoursConfig(),
    listPromotions(true),
  ]);
  const byId = Object.fromEntries(menu.items.map((m) => [m.id, m]));
  const pickupWins = pickupWindows(hours);
  const deliveryWins = deliveryWindows(hours);
  const testMode = !process.env.STRIPE_SECRET_KEY;
  // Hero media: an optional custom hero photo / hero video (Admin →
  // Operations, kept in dish_photos under reserved ids) wins; until the
  // owner uploads one, the hero shows the house signature (Sultani),
  // like the reference site.
  const heroDish =
    byId["sultani-kabob"] ??
    POPULAR_NOW.map((id) => byId[id]).find(Boolean) ??
    menu.items.find((m) => m.image);
  const heroPhotoSrc = heroDish
    ? (photos[HERO_PHOTO_ID] ?? photos[heroDish.id] ?? heroDish.image)
    : undefined;
  const heroVideoSrc = photos[HERO_VIDEO_ID];

  function dishCard(m: MenuItem) {
    return (
      <Link href="/menu" className="card home-card" key={m.id}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={photos[m.id] ?? m.image} alt={m.name} loading="lazy" />
        <div className="card-body">
          <h3>
            {m.number && <span className="num">{m.number}</span>}
            {m.name}
          </h3>
          <p>{m.description}</p>
          <div className="price-row">
            <span className="price">{formatCents(m.price_cents)}</span>
            <span className="add-btn">Order →</span>
          </div>
        </div>
      </Link>
    );
  }

  return (
    <>
      {testMode && (
        <div className="testmode-banner">
          TEST MODE — no real payment is taken. Orders are marked “test paid”.
        </div>
      )}

      <section className="hero-stage">
        <div className="hero-inner">
          <div className="hero-copy">
            <p className="hero-kicker light">Aurora, Colorado · 100% halal</p>
            <h2>Fire-grilled kabobs, fresh bread and saffron rice.</h2>
            <p className="hero-sub">
              Order online for pickup or delivery. Made to order in our kitchen
              on South Parker Road.
            </p>
            <div className="hero-actions">
              <Link href="/menu" className="btn-accent">
                Start your order →
              </Link>
              <Link href="/visit" className="btn-stage">
                Hours &amp; location
              </Link>
            </div>
            <p className="hero-meta">
              <span className="dot" aria-hidden="true" />
              3126 S Parker Rd, Aurora, CO 80014
            </p>
          </div>
          {heroDish && heroPhotoSrc && (
            heroVideoSrc ? (
              <video
                className="hero-photo"
                poster={heroPhotoSrc}
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
              >
                <source src={heroVideoSrc} />
              </video>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                className="hero-photo"
                src={heroPhotoSrc}
                alt={heroDish.name}
              />
            )
          )}
        </div>
      </section>

      <main className="wrap">
        {promos.length > 0 && (
          <section className="home-section">
            <div className="section-head">
              <h2>Deals for you</h2>
              <Link href="/deals">See all →</Link>
            </div>
            {promos.map((p) => {
              const dish = p.item_id ? byId[p.item_id] : null;
              return (
                <div className="promo-box" key={p.id}>
                  {dish && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={photos[dish.id] ?? dish.image} alt={dish.name} />
                  )}
                  <div className="promo-text">
                    <strong>🎁 {p.title}</strong>
                    {p.body && <span>{p.body}</span>}
                    {dish && (
                      <span className="promo-dish">
                        {dish.name} · {formatCents(dish.price_cents)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        )}

        <section className="home-section">
          <div className="section-head">
            <h2>How would you like it?</h2>
          </div>
          <div className="how-grid">
            <Link href="/menu" className="how-card">
              <span className="how-icon">🏃</span>
              <strong>Pickup</strong>
              <span className="how-desc">Order ahead — ready when you arrive. Pay online or at the counter.</span>
              <span className="how-link">Order pickup →</span>
            </Link>
            <Link href="/menu" className="how-card">
              <span className="how-icon">🛵</span>
              <strong>Delivery</strong>
              <span className="how-desc">Hot and fresh to your door within about 4 miles of the restaurant.</span>
              <span className="how-link">Order delivery →</span>
            </Link>
            <Link href="/rewards" className="how-card">
              <span className="how-icon">⭐</span>
              <strong>Rewards</strong>
              <span className="how-desc">Earn 1 point per $1 on paid orders — 100 points = $5.00 off.</span>
              <span className="how-link">See rewards →</span>
            </Link>
          </div>
        </section>

        <section className="home-section">
          <div className="section-head">
            <h2>Guest favorites</h2>
          </div>
          <div className="menu-grid">
            {GUEST_FAVORITES.map((id) => byId[id]).filter(Boolean).map(dishCard)}
          </div>
        </section>

        <section className="home-section">
          <div className="section-head">
            <h2>Popular right now</h2>
            <Link href="/menu">Full menu →</Link>
          </div>
          <div className="menu-grid">
            {POPULAR_NOW.map((id) => byId[id]).filter(Boolean).map(dishCard)}
          </div>
        </section>

        {menu.categories.length > 0 && (
          <section className="home-section">
            <div className="section-head">
              <h2>Explore the menu</h2>
            </div>
            <div className="cat-pills">
              {menu.categories.map((c) => (
                <Link key={c} href="/menu" className="cat-pill">
                  {c}
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="home-section">
          <div className="rewards-band">
            <div className="band-copy">
              <p className="band-kicker">Madinah Rewards</p>
              <h2>Earn 1 point for every $1 you spend</h2>
              <p>
                Trade points for money off your next order — 100 points = $5.00
                off. Sign in and your points add up on every paid order.
              </p>
            </div>
            <Link href="/account" className="btn-accent">
              Join for free
            </Link>
          </div>
        </section>

        <section className="home-section visit-box">
          <h2 className="category-title">Visit us</h2>
          <p>
            <strong>Madinah Market</strong>
            <br />
            3126 S Parker Rd, Aurora, CO 80014
            <br />
            <a href="tel:+17207630786">📞 720-763-0786</a>
            {" · "}
            <a
              href="https://www.google.com/maps/search/?api=1&query=3126+S+Parker+Rd+Aurora+CO+80014"
              target="_blank"
              rel="noreferrer"
            >
              Get directions →
            </a>
          </p>
          <h3>Opening hours</h3>
          <p>
            🏃 Pickup: Mon–Sat {formatWindow(pickupWins[1])} · Sun {formatWindow(pickupWins[0])}
            <br />
            🛵 Delivery: Mon–Sat {formatWindow(deliveryWins[1])} · Sun {formatWindow(deliveryWins[0])}
          </p>
        </section>
      </main>

      <footer className="site-footer">
        Madinah Market · 3126 S Parker Rd, Aurora, CO 80014 ·{" "}
        <a href="tel:+17207630786">720-763-0786</a>
        <br />
        Aurora, Colorado · 100% Halal · Kabob, Turkish, Afghan Persian &amp; Middle Eastern
        <br />
        <a href="/privacy">Privacy Policy</a> ·{" "}
        <a href="/terms">Terms &amp; Conditions</a>
      </footer>
    </>
  );
}
