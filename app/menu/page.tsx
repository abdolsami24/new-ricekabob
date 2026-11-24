import Storefront from "@/components/Storefront";
import { getDbMenu } from "@/lib/menuDb";
import { getFeeSettings } from "@/lib/fees";

// The server tells the storefront whether the site is in TEST MODE
// (no STRIPE_SECRET_KEY configured) so the banner can be shown, and
// loads the menu (database menu when the admin tables exist, else the
// built-in menu from lib/menu). It also passes the Service Fee /
// Free Delivery settings so the checkout preview can show the same
// totals the server will charge (checkout re-computes them anyway;
// these reads fail soft to OFF).
export const dynamic = "force-dynamic";

export default async function MenuPage() {
  const testMode = !process.env.STRIPE_SECRET_KEY;
  const [menu, fees] = await Promise.all([getDbMenu(), getFeeSettings()]);
  return (
    <Storefront testMode={testMode} menu={menu.items} categories={menu.categories} fees={fees} />
  );
}
