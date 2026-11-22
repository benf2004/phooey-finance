# Deploy phooey! finance on Cloudflare

This checkout has the commercial control database, the first workspace manifest, and private service keys prepared. Run the commands from the project root on a Mac that can reach Cloudflare. Use the Cloudflare account that owns **phooey.foo**.

**To publish the promotional site immediately**, run `npm run hosted:launch -- site` from the project root. It publishes the marketing pages on **getfinance.phooey.foo** using the existing commercial control database. Google, Apple, and Stripe credentials can be added afterward.

## 1. Connect Google, Apple, and Stripe

Fill in the settings below in `.private/launch/providers.json`. Keep this file private. The following URLs can be registered before the domains go live.

| Provider | Values for the file | Register with the provider |
| --- | --- | --- |
| Google | `googleLoginClient` (Web application client ID) | Authorized JavaScript origin `https://finance.phooey.foo` |
| Apple | `appleLoginClient` (Services ID) and `APPLE_LOGIN_SECRET` (signed JWT) | Domain `finance.phooey.foo` and return URL `https://finance.phooey.foo/identity/v1/authorize-apple` |
| Resend | `RESEND_API_KEY` and `RESEND_SENDER_ADDRESS` | Verify the sending domain for signup verification and password resets |
| Stripe | `stripePrice`, `STRIPE_SECRET`, `STRIPE_WEBHOOK_SECRET` | Create a USD **$29/year** recurring price, enable the billing portal, and send events to `https://finance.phooey.foo/cloud/webhook` |

To import Google's downloaded Web client JSON and generate the Apple JWT locally, run:

```sh
node scripts/setup-social.mjs google /path/to/google-client.json
node scripts/setup-social.mjs apple /path/to/AuthKey.p8 TEAM_ID KEY_ID SERVICES_ID
```

The signup link opens `https://finance.phooey.foo/cloud/signup`. New accounts enter a card at Stripe Checkout for a 14-day free trial, followed by $29/year unless canceled. The Worker sets the trial on the Checkout session. Keep the annual price at $29. In your live Stripe customer portal settings, enable subscription cancellation so subscribers can cancel from **Manage billing** before their first charge.

Melody returns the browser to `https://finance.phooey.foo/cloud/callback`. The launch command registers this Finance client automatically. Renew the Apple JWT before the expiry date printed by the setup script.

Select Stripe events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. Bank syncing is billed separately.

To deploy just the private identity Worker before configuring billing, run `npm run hosted:launch -- prepare` followed by `npm run hosted:auth`. The public sign-in URL becomes available once the Finance portal owns its domain.

## 2. Publish the bundle

```sh
cd /Users/benhome/Desktop/Projects/phooey-finance
npx wrangler whoami
npm run hosted:launch -- deploy
```

If `whoami` shows the wrong account or asks you to authenticate, run `npx wrangler login`. The release command installs the pinned Melody Auth server as a private Worker with dedicated D1 and KV, registers the Finance client, checks the account and price, creates or reuses the invoice D1 database, applies the migrations, and publishes the private Invoicer Worker, workspace, and public portal. Open [getfinance.phooey.foo](https://getfinance.phooey.foo/) to verify the marketing site. Hosted sign-in becomes available after the app domain moves in step 3.

## 3. Move the app domain

To point the app domain at the hosted bundle, run:

```sh
npm run hosted:launch -- cutover
```

Approve the reassignment of **finance.phooey.foo** from `phooey-finance` to `phooey-hosted-portal` if Wrangler prompts. If it reports a domain conflict, detach only that custom domain from the old Worker in **Workers & Pages → phooey-finance → Settings → Domains & Routes**, then rerun the command. The personal database stays on its existing Worker. The command checks the signed-out redirect, the Melody authorization route and both configured provider IDs. Then sign in with Google and Apple at [finance.phooey.foo/cloud/start](https://finance.phooey.foo/cloud/start) to verify each provider registration.

[Cloudflare custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) · [Full operations guide](hosted-launch.md)


### Account security

After signing in, open **Your Phooey account → Sign-in and security**. Link another Google, Apple, or verified email/password login from the existing account to keep the same subscription. Register a primary passkey there for future sign-ins.

Two-factor authentication is optional. An authenticator app works after any primary login, including passkey. A user may enroll security keys or passkeys as second factors when their account has no primary passkeys. If both second-factor methods are enabled, either completes sign-in. Changes to factor enrollment sign out existing sessions.

Back up `.private/launch/factor-encryption.json` with the production secrets. It holds the portal key for encrypted authenticator seeds. A lost second factor requires another enrolled second factor to regain access. Password reset still requires the configured second step on the next sign-in.


### Manage hosted users

Sign in at [Your Phooey account](https://finance.phooey.foo/cloud/account) and copy your **Account ID**. You can do this before starting checkout. From the project folder, run the following once using the Cloudflare account that owns the production control database.

```sh
npm run hosted:admin -- YOUR_ACCOUNT_ID
```

Open [Hosted accounts](https://finance.phooey.foo/admin) to view registered users, email addresses, workspace assignments, and billing or signup status. Under **Create a free account**, enter an email address and share the signup link with its owner. They must sign in with that verified email. Existing users who have never started checkout can receive access the same way. A grant reserves a workspace immediately and includes Finance and Invoicer without Stripe checkout. If all slots are assigned, provision a fresh workspace before retrying.

The directory and grants live in the shared D1 database `phooey-hosted-control`. The `account_admins` table assigns administrator access by user ID. The `free_accounts` table records who granted each account and when.

### Reset the old personal ledger

Open the [personal Finance Worker](https://phooey-finance.aipromptgenius.workers.dev), sign in, and open **Settings → Reset app data**. Type `RESET EVERYTHING` and submit. This clears the old personal ledger and schedules its file cleanup. The hosted databases use separate bindings.
