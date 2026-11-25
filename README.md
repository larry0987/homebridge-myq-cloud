# Homebridge MyQ Cloud

A Homebridge dynamic platform plugin for MyQ residential garage door openers. It discovers openers from every account returned by MyQ, exposes each as a HomeKit Garage Door Opener, polls cloud state, and sends the MyQ open and close commands.

## MyQ authentication status and required credential

MyQ does not publish a supported residential cloud API. This plugin follows the endpoints, OAuth parameters, and device families used by the community-maintained [bvdcode Home Assistant MyQ integration](https://github.com/bvdcode/home-assistant-myq). MyQ uses OAuth 2.0 authorization code with PKCE for sign-in, then a refresh token for ongoing access. MyQ may change or restrict these undocumented endpoints without notice; authorization may also be rate-limited or revoked.

The plugin accepts an **OAuth refresh token** for ongoing access. You can obtain one directly from MyQ with the included sign-in helper; Home Assistant and its MyQ integration are not required. The helper opens MyQ's browser sign-in, where you enter your MyQ credentials and complete any verification. It never asks for or stores your password. You can still use an existing token from the referenced Home Assistant integration if you prefer.

The plugin saves access tokens and any rotated refresh token to `myq-cloud-token.json` in Homebridge's storage directory, using restrictive file permissions. Back up that file securely; a MyQ account can revoke its tokens. If refresh fails, reauthorize with MyQ and replace `refreshToken` in plugin settings.

## Install

For local development, from this directory run:

```sh
npm install
npm test
npm link
```

Then install/enable **Homebridge MyQ Cloud** from the Homebridge UI or add the platform configuration below and restart Homebridge. For a published package, install it with `npm install -g homebridge-myq-cloud`.

## Get a MyQ refresh token without Home Assistant

Run the included helper on a computer with Node.js 20 or newer and internet access. It has no npm dependencies:

```sh
git clone https://github.com/larry0987/homebridge-myq-cloud.git
cd homebridge-myq-cloud
npm run myq:login
```

Open the MyQ authorization link printed by the helper, sign in on MyQ's website, and finish any email/SMS verification. When MyQ redirects to `com.myqops://android`, copy the complete URL from the browser address bar and paste it into the waiting terminal prompt. If the browser says it cannot open the app link, copy the address anyway. The helper checks the OAuth state and issuer, exchanges the one-time code with PKCE, and prints the refresh token. Paste that token into the Homebridge plugin configuration. The helper does not save the token to disk; keep it private and do not share the callback URL or token.

This uses MyQ's undocumented OAuth flow and the Firebase App Check registration used by the reference integration. MyQ can change or block this flow without notice. The helper communicates with MyQ Identity and Firebase App Check; it does not send credentials to Home Assistant or to a Homebridge server.

## Configuration

Homebridge Config UI X configuration uses the plugin's platform form. In JSON configuration:

```json
{
  "platform": "MyQCloud",
  "name": "MyQ",
  "refreshToken": "YOUR_MYQ_OAUTH_REFRESH_TOKEN",
  "pollIntervalSeconds": 120,
  "showOfflineDoors": true
}
```

Do not commit this configuration or expose the refresh token in logs. Minimum regular polling interval is one minute; the default is two minutes. After an accepted open/close command, the plugin checks cloud status after 1, 2, 3, 4, and then every 5 seconds. It keeps this faster polling for at least 30 seconds and up to 60 seconds while waiting for MyQ to report the requested state, then returns to the configured regular interval. HomeKit only reports movement after MyQ confirms it in cloud status.

## Behavior and limitations

- Requires a MyQ residential account with garage openers visible to the official MyQ service. This is a cloud integration; Homebridge needs internet access.
- HomeKit presents cloud-reported open, closed, opening, closing, and stopped states. Unknown status remains unknown, and MyQ offline doors are unavailable to command.
- Device/account discovery follows MyQ's current `accounts`, `Devices`, and `door_openers/{serial}/{open|close}` API families and API versions. These are private, reverse-engineered interfaces.
- The helper relies on MyQ's browser sign-in for credentials and MFA. Camera feeds, standalone lights, and HomeKit sensors are not included.
- Opening or closing a garage door can cause injury or property damage. Keep the doorway clear and maintain the opener's safety sensors. This plugin does not bypass MyQ or opener safety controls.
- Not affiliated with or endorsed by The Chamberlain Group LLC. MyQ, Chamberlain, and LiftMaster are their respective owners' marks.

## Development

Run `npm test` with Node.js 20 or newer. The tests cover state translation, endpoint selection, and command polling timing; cloud account access requires a valid MyQ credential and is not exercised by the local test suite.

