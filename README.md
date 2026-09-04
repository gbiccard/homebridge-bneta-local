# homebridge-bneta-local

Local-LAN control of BNETA/Tuya Wi-Fi smart plugs for Homebridge. It supports HomeKit/HAP and Homebridge 2's native Matter bridge from one shared device connection. Automatic LAN discovery can optionally use Tuya Cloud for inventory and local-key onboarding; all device commands and polling remain local.

## Architecture and requirements

Homebridge 2.0+ has an optional in-process Matter bridge. This plugin explicitly registers an `OnOffOutlet` with that API while also creating the normal HomeKit Outlet service. A separate Matterbridge companion is therefore unnecessary and is intentionally not included: two processes polling and writing the same plug would create avoidable races, extra sockets, and confusing state.

- Node.js 22, 24, or 26
- Homebridge 2.2.1 or newer
- BNETA plug already joined to the same LAN
- Either Tuya Cloud project credentials or a device ID/local key for each plug
- 2.4 GHz reachability and TCP port 6668 between Homebridge and the plug

Homebridge's Matter bridge is community software and is not CSA-certified. Controllers may show an uncertified-accessory warning. Matter commissioning also needs working IPv6 and mDNS on the LAN.

## Install and build

For local development:

```sh
npm install
npm run build
npm test
npm link
```

Restart Homebridge after linking. For an npm-published version, install it from the Homebridge UI or run `npm install -g homebridge-bneta-local`.

## Discovery and onboarding

LAN discovery is enabled by default. It listens for Tuya broadcasts on UDP 6666/6667 and actively discovers newer 3.5 devices on UDP 7000. It supplies device IDs, private IP addresses, product IDs, and protocol versions where advertised. Rediscovery runs every five minutes by default.

Tuya deliberately does not broadcast local encryption keys. Choose one onboarding method:

1. **Cloud-assisted:** create a Tuya IoT Cloud project, link the Smart Life/Tuya Smart app account, and enter the project's Access ID, Access Secret, and matching data-centre region. The plugin fetches inventory and keys, joins it to LAN discoveries, and then controls the plugs locally.
2. **LAN-only:** add each device ID and 16-character local key under `devices`. Name, IP, version, and DPS fields are optional overrides because discovery fills what it can.

For cloud-assisted onboarding, create a **Smart Home** cloud project in the [Tuya IoT Platform](https://iot.tuya.com/cloud/), select the data centre matching the app account, enable its device-management permissions, and use **Devices → Link Tuya App Account** to scan the QR code with Smart Life. Copy the project Access ID and Access Secret into Homebridge. You do not enter your Smart Life email or password in this plugin.

A local key changes when a plug is removed and paired again. Treat local keys, Access IDs, and Access Secrets like passwords.

## Homebridge configuration

After installation, open **Homebridge → Plugins → BNETA Local → Settings**. The graphical interface includes LAN discovery, cloud credentials, data-centre selection, Matter publication, device filters, device-managed inching, persistent socket options, manual local keys, connection timing and advanced DPS mappings. Editing `config.json` by hand is not required.

For automatic cloud-assisted onboarding, enable **Use Tuya Cloud for device names and local keys** in that interface. No device list is needed. The resulting configuration is equivalent to:

```json
{
  "platform": "BNETALocal",
  "name": "BNETA Local",
  "discovery": {
    "enabled": true,
    "timeout": 15,
    "refreshInterval": 300,
    "categories": ["cz", "pc"]
  },
  "matter": {
    "enabled": true,
    "electricalMeasurements": true
  },
  "cloud": {
    "enabled": true,
    "accessId": "YOUR_TUYA_ACCESS_ID",
    "accessSecret": "YOUR_TUYA_ACCESS_SECRET",
    "region": "eu",
    "refreshInterval": 3600
  },
  "defaultFeatures": {
    "powerOnState": "memory",
    "indicatorMode": "relay",
    "childLock": "unchanged",
    "overchargeProtection": "unchanged",
    "inching": {
      "mode": "enabled",
      "duration": 2,
      "channel": 0
    }
  }
}
```

The example above enables two-second device-managed inching on every compatible discovered plug. Select **Leave device setting unchanged** instead if only particular plugs should use inching, then add those device IDs under Manual overrides.

Choose the region shown by the Tuya IoT project; it must match the data centre holding the linked app account. The default categories are Tuya socket (`cz`) and power strip (`pc`), preventing discovered bulbs and other Tuya products from being exposed as outlets.
Tuya's current default mapping places South African app accounts in the **Central Europe** data centre, so use `"region": "eu"` unless your project explicitly shows a different data centre.

For LAN-only onboarding or per-device overrides:

```json
{
  "platform": "BNETALocal",
  "name": "BNETA Local",
  "devices": [
    {
      "name": "Desk Plug",
      "id": "bf0123456789abcdef",
      "key": "0123456789abcdef",
      "ip": "192.168.1.42",
      "version": "3.3",
      "pollInterval": 30,
      "retryInterval": 5,
      "dps": {
        "switch": 1,
        "countdown": 9,
        "energy": 17,
        "current": 18,
        "power": 19,
        "voltage": 20,
        "fault": 26,
        "powerOnState": 38,
        "overchargeProtection": 39,
        "indicatorMode": 40,
        "childLock": 41,
        "inching": 44,
        "energyScale": 1000,
        "currentScale": 1000,
        "powerScale": 10,
        "voltageScale": 10
      }
    }
  ]
}
```

Only `id` and `key` are required in a LAN-only manual entry; with Cloud onboarding, the key can be omitted. Common plugs use switch `1`, countdown `9`, accumulated energy `17` (0.001 kWh), current `18` (mA), power `19` (0.1 W), voltage `20` (0.1 V), fault `26`, power-on state `38`, overcharge protection `39`, indicator mode `40`, child lock `41`, and inching `44`. The plugin also detects common `2`, `4`/`5`/`6`, `7`, `14`/`15`/`19`, `20`/`21`/`22`/`23`, and `29` variants. Unknown readings are ignored and unsupported writable DPS are never sent.

## Device features and inching

The **Default features for discovered plugs** section applies persistent settings without requiring a manual device list. A matching entry under **Manual local keys and device overrides** can override them for one plug.

- **Device-managed inching:** the plug switches itself off 1–65,535 seconds after it turns on, even while Homebridge is offline. Channel `0` is correct for a single BNETA outlet. The plugin uses Tuya's native Base64 inching frame and writes it only when the requested setting differs from the device.
- **Power restoration:** off, on, or restore the previous relay state.
- **Indicator LED:** off, always on, follow the relay, or operate opposite to the relay.
- **Child lock:** disables or enables the physical button. Where reported, HomeKit also receives the standard Lock Physical Controls characteristic.
- **Overcharge protection:** enables or disables the firmware's supported protection switch.
- **Countdown:** exposed through HomeKit Set Duration and Remaining Duration characteristics when the device reports a countdown DPS. HomeKit's standard characteristic permits up to 3,600 seconds; Tuya itself supports up to 86,400 seconds.
- **Faults and energy:** faults map to HomeKit Status Fault, and accumulated energy is exposed alongside current, power, and voltage.

Tuya treats inching and some timer-dependent functions as mutually exclusive. If you use device-managed inching, avoid configuring a conflicting countdown, cycle timer, or random timer in Smart Life.

The connection is persistent, state is polled, push updates are consumed, and failed connections retry with capped exponential backoff. Commands connect first and reject cleanly if the plug remains unavailable.

## Enable and pair Matter

1. In the BNETA Local plugin settings, enable **Publish discovered plugs through Matter**.
2. In Homebridge UI, run the plugin as a child bridge (recommended for isolation).
3. Enable **Matter** for that child bridge; leave HAP enabled if you also want its HomeKit QR code.
4. Restart the child bridge.
5. Open its Matter pairing code/QR in Homebridge UI and add it to Apple Home, Google Home, Alexa, or another Matter controller.

Matter exposes on/off plus voltage, active current, active power, and cumulative imported energy when **Publish voltage, current, power and energy through Matter** is enabled. Values are converted to Matter's required millivolt, milliamp, milliwatt, and milliwatt-hour units. HomeKit/HAP additionally receives countdown, child-lock, fault, and Eve-compatible electrical characteristics. Controller applications decide which optional Matter readings they display.

Do not add the same physical plug to a second local-Tuya plugin or Matterbridge instance. If migrating, stop the old integration first, then start this one.

## Docker / Homebridge image

For the supplied private package on iHost:

1. Copy `homebridge-bneta-local-0.3.1.tgz` into the persistent folder mounted as `/homebridge` in the container.
2. Open **Homebridge → Settings → Startup & Environment → Startup Script** (or the iHost container console) and install it with:

   ```sh
   npm install -g --omit=dev /homebridge/homebridge-bneta-local-0.3.1.tgz
   ```

3. Keep that command in Homebridge's Startup Script so the private plugin is restored whenever iHost recreates or updates the container, then restart Homebridge.
4. Open **Plugins → BNETA Local → Settings**. To configure every compatible discovered plug, expand **Default features for discovered plugs**, set **Inching mode** to **Enable device-managed inching**, choose the delay, and leave the channel at `0` for a single socket.

- Use host networking; Tuya UDP discovery and Matter mDNS do not traverse Docker's default bridge reliably.
- On SONOFF iHost, edit the Homebridge container in **Docker → Containers**, set its network mode to **host**, retain the existing persistent `/homebridge` volume, then recreate/restart that container.
- If host networking is unavailable, give every plug a DHCP reservation and set `ip`; expose the Homebridge/Matter ports configured by your installation and ensure IPv6/mDNS reach the controller LAN.
- Mount Homebridge's storage directory persistently so cached HAP/Matter accessories and pairings survive container recreation.
- Keep the container and plugs on the same trusted IoT LAN, or explicitly allow TCP 6668 and the required discovery/mDNS traffic between VLANs.
- Homebridge 2.2's Matter responder shares mDNS port 5353. If IPv4 mDNS conflicts with Avahi/systemd-resolved, the Homebridge UI offers `disableIpv4` for Matter; Matter itself requires IPv6.

## Troubleshooting

- **Timeout:** reserve/set the IP, confirm port 6668 and VLAN/firewall rules, then verify protocol version.
- **Discovered but no key:** configure Tuya Cloud onboarding or add that device ID and local key under `devices`.
- **Cloud permission error:** confirm the app account is linked to the correct Tuya project/data centre and the project's IoT Core device permissions are active.
- **Decrypt/sign error:** the local key or protocol version is wrong; re-fetch the key after any re-pairing.
- **Wrong switch:** try DPS `20` instead of `1` and inspect device DPS using TuyAPI tooling.
- **Matter QR missing:** confirm Homebridge 2.2+, enable Matter on the same main/child bridge that runs the plugin, and restart it.
- **Duplicate tile:** the HAP and Matter pairings are separate transports. Pair only the transport(s) you want into a given ecosystem.

## Security

The plugin makes direct encrypted Tuya-protocol connections on the LAN. When cloud onboarding is configured, it calls Tuya only to refresh device inventory and local keys—never to control a plug. The plug's own firmware may still contact Tuya unless blocked separately. Restrict access to Homebridge configuration because it can contain local keys and cloud credentials.
