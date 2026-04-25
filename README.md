# AutoTrust Ledger

Blockchain demo for vehicle identity, maintenance history, accident records, odometer fraud prevention, and tamper alerts.

## Demo Roles

- Buyer: searches a VIN before buying a used car and sees verified history.
- Service Company: adds registration, service, repair, accident, and insurance records.
- Seller: adds resale declarations and ownership transfer records before selling a car.
- Hidden Security Console: tries to rewrite an existing record from a separate test URL. Buyer, Seller, and Service dashboards do not see who sent the request; they only see that an unauthorized write was blocked.

## Run On One Laptop

Open two terminals in the `frontend` folder.

Terminal 1:

```bash
npm run server
```

Terminal 2:

```bash
npm run dev -- --host 0.0.0.0
```

On Windows PowerShell, if `npm` is blocked by execution policy, use:

```bash
npm.cmd run server
npm.cmd run dev -- --host 0.0.0.0
```

## Run On 3 To 4 Laptops

1. Start the backend and frontend on the host laptop.
2. Find the host laptop IPv4 address with `ipconfig`.
3. Open `http://HOST-IP:5173` on every laptop connected to the same Wi-Fi.
4. Choose different roles on each laptop:
   - Laptop 1: Buyer
   - Laptop 2: Service Company
   - Laptop 3: Seller
   - Laptop 4: Hidden Security Console at `http://HOST-IP:5173/?role=attacker`

## Demo Flow

1. Buyer opens VIN `VIN1001` and verifies the history.
2. Service Company adds a new service or accident record. The record becomes a new block.
3. Service Company or Seller can upload an odometer photo. OCR reads the visible number from the image, and the record is accepted only when that OCR reading matches the odometer value.
4. Service Company or Seller can upload up to 8 car photos with the record for stronger visual trust.
5. Seller adds a `Seller Declaration` or `Ownership Transfer` record.
6. Buyer sees the new blocks live.
7. On the hidden security laptop, select `VIN1001`, choose an existing block, and attempt to lower the odometer or erase accident history.
8. The attack is rejected. Buyer, Seller, and Service Company receive an alert, but they do not see the attacker's identity. The blocked attempt is recorded as a new security block.

## Ports

- Frontend: `5173`
- Backend API and Socket.IO: `3001`

If `3001` is already running, start the backend on another port and open the frontend with `?apiPort=PORT`, for example `http://localhost:5173?apiPort=3003`.

Use the same `apiPort` link on every laptop. If one laptop uses `3001` and another uses `3003`, they are writing to different in-memory ledgers and records will not appear live across devices.

If Windows Firewall asks, allow Node.js on private networks.
