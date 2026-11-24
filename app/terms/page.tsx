// Terms and conditions for Madinah Market online ordering,
// including the SMS (text message) order-update program terms
// required for A2P 10DLC registration. Linked from the site footer flow.

export const metadata = { title: "Terms & Conditions — Madinah Market" };

export default function TermsPage() {
  return (
    <main
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: "2rem 1.25rem 4rem",
        lineHeight: 1.65,
      }}
    >
      <p>
        <a href="/menu">← Back to menu</a>
      </p>
      <h1>Terms &amp; Conditions — Madinah Market</h1>
      <p>
        <em>Last updated: November 18, 2026</em>
      </p>
      <p>
        Madinah Market ("we", "us") operates this website for online food
        ordering (pickup and delivery). By placing an order on this website,
        you agree to these terms.
      </p>

      <h2>Orders and payment</h2>
      <ul>
        <li>
          Prices are shown in US dollars and may change without notice. The
          total shown at checkout (including tax, any service fee, delivery
          fee, and tip) is the amount you pay.
        </li>
        <li>
          Card payments are processed by Stripe. An order is confirmed when
          payment succeeds and you receive an order confirmation.
        </li>
        <li>
          Pickup orders are held at the restaurant counter. Delivery orders
          are delivered to the address you provide at checkout by our
          delivery partner.
        </li>
        <li>
          If we cannot complete your order, we will contact you at the phone
          number you provided and arrange a refund or an alternative.
        </li>
      </ul>

      <h2>Text message (SMS) program — order updates</h2>
      <ul>
        <li>
          <strong>Program name:</strong> Madinah Market order updates.
        </li>
        <li>
          <strong>What we send:</strong> when you provide your mobile phone
          number at checkout, we send text messages about your own order
          only — for example an order confirmation, a ready-for-pickup
          notice, and delivery status updates. We do not send marketing or
          promotional text messages under this program.
        </li>
        <li>
          <strong>Message frequency varies</strong> (normally 1–3 messages
          per order). <strong>Message and data rates may apply</strong>{" "}
          depending on your mobile carrier plan.
        </li>
        <li>
          <strong>Opt out:</strong> reply <strong>STOP</strong> to any
          message to stop receiving order-update texts. You will receive one
          final confirmation message.
        </li>
        <li>
          <strong>Help:</strong> reply <strong>HELP</strong> to any message,
          or call us at 720-763-0786.
        </li>
        <li>
          Providing a phone number is not a condition of purchase — you may
          order without text updates by asking us in store or by phone.
          Mobile carriers are not liable for delayed or undelivered
          messages.
        </li>
      </ul>

      <h2>Loyalty points</h2>
      <p>
        If you order while signed in, you earn 1 point for every $1 paid.
        100 points can be redeemed for $5.00 off a future order. Points have
        no cash value and may be adjusted if an order is cancelled or
        refunded.
      </p>

      <h2>Contact</h2>
      <p>
        Madinah Market
        <br />
        3126 S Parker Rd, Aurora, CO 80014
        <br />
        Phone: 720-763-0786
        <br />
        Email: Abdolsami@yahoo.com
      </p>
    </main>
  );
}
