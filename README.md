# PermitGet POC

This is the frontend proof-of-concept for **PermitGet**, built with Next.js and deployed on Vercel.

## Features
- Address lookup (via Nominatim → lat/lon)
- Jurisdiction resolution (via Supabase + PostGIS)
- Permit type search (`pool`, `roof`, `fence`, etc.)
- Links to either PDF forms or online portals

## Tech Stack
- **Next.js** (frontend + API routes)
- **Supabase** (DB + PostGIS + RPC)
- **Nominatim** (geocoding)
- **Vercel** (hosting)

## Running locally

```bash
npm install
npm run dev
