import { getHoursConfig } from "@/lib/admin";
import {
  pickupWindows,
  deliveryWindows,
  formatWindow,
} from "@/lib/hours";

// Visit: address, phone, opening hours and a directions link.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Visit Us — Madinah Bakery & Kabob",
  description:
    "Madinah Bakery & Kabob, 3126 S Parker Rd, Aurora, CO 80014. Call 720-763-0786.",
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default async function VisitPage() {
  const hours = await getHoursConfig();
  const pickup = pickupWindows(hours);
  const delivery = deliveryWindows(hours);

  return (
    <main className="wrap">
      <h2 className="category-title">Visit us</h2>
      <div className="panel visit-panel">
        <p className="visit-name">
          <strong>Madinah Bakery &amp; Kabob</strong>
        </p>
        <p>Aurora, Colorado · 100% halal</p>
        <p>
          📍 3126 S Parker Rd, Aurora, CO 80014
          <br />
          <a
            className="hero-cta small"
            href="https://www.google.com/maps/search/?api=1&query=3126+S+Parker+Rd+Aurora+CO+80014"
            target="_blank"
            rel="noreferrer"
          >
            Get directions →
          </a>
        </p>
        <p>
          📞 <a href="tel:+17207630786">720-763-0786</a>
        </p>
        <h3>Opening hours</h3>
        <table className="hours-table">
          <thead>
            <tr>
              <th>Day</th>
              <th>🏃 Pickup</th>
              <th>🛵 Delivery</th>
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3, 4, 5, 6, 0].map((d) => (
              <tr key={d}>
                <td>{DAYS[d]}</td>
                <td>{formatWindow(pickup[d])}</td>
                <td>{formatWindow(delivery[d])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Ordering ahead? <a href="/menu">See the menu and order online →</a>
        </p>
      </div>
    </main>
  );
}
