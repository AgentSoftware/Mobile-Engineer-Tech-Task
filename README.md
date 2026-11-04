# Doorstep: mobile engineer tech task

## The brief

**Estate agents** sell and rent out homes on behalf of their owners. They work from local **branches**, and each branch handles both **sales** and **lettings** (rentals).

- **Negotiators** are the branch staff who book viewings and show people around. They'll use the app. In the API they are `agents`.
- **Applicants** are people looking to buy or rent who have registered with the agency. In the API they are `people` with the role `applicant`.
- **Owners** are the agency's clients: people selling a home (**vendors**) or renting one out (**landlords**). In the API they are `people` with the role `owner`.

## What we want from you

Meet Alex, a negotiator at our branch in Didsbury, Manchester. Alex's working day happens in the car and on doorsteps, going from one viewing to the next. Alex's phone is the office. We want the app to support two parts of Alex's day.

**1. Alex's viewing day.** Alex needs to know what's coming up and where to be. Alex needs to get there, deal with the people involved (the applicant, the owner, colleagues) and handle what changes on the day. Once a viewing is done, Alex needs to capture how it went while it's still fresh.

**2. Booking a viewing.** Applicants ring Alex between viewings. Alex wants to book them in on the spot, for a property they're interested in, at a time that works. Sometimes the caller hasn't registered with us yet.

Build a solution for those two parts of Alex's day: a mobile app, in `app/` (a blank Expo app), that runs against the mock Doorstep API in `server/` (see [`server/API.md`](server/API.md)).

The product team has collected more problems from agents and the wider business. They're tickets in `backlog/`.

That's all the product detail there is. The rest is up to you.

## Rules

- **Tools:** use whatever libraries, tools and AI assistants you like. We expect you to use AI.
- **The server** stands in for an API another team runs. You can change it, but keep what's there working (its errors, delays and `FAILURE_RATE`) and explain each change in your write-up.

## Getting started

You'll need Node 22 or later, Xcode with an iOS simulator, and Android Studio with an emulator.

```bash
# 1. Start the API (keep it running)
cd server
npm install
npm start
```

The server prints a local address and a network address. Sign in as `alex.morgan@example.com` with the password `doorstep`. Restarting the server resets all data and signs everyone out.

```bash
# 2. Build and run the app
cd app
npm install
npx expo run:ios       # or: npx expo run:android
```

The first native build takes a few minutes. After that, JavaScript changes reload straight away. Last checked with Expo SDK 58, Xcode 27.2, an Android 14 (API 34) emulator and Node 24.

## Submitting

1. Make your own copy with **Use this template → Create a new repository**, and set it to **Private**. Please don't fork it or make it public.
2. Include a short write-up of the decisions you made, in whatever form suits you.
3. Include short screen recordings of the app running, in the repo or linked from your write-up.

## Glossary

| Term | Meaning |
|---|---|
| Guide price, Offers over, Offers in the region of | Ways of advertising an asking price |
| Under offer, Sold STC | An offer has been accepted; "subject to contract" means the sale isn't legally done yet |
| To let, Let agreed | Available to rent; a tenant has been found |
| Freehold, Leasehold | You own the building and its land outright, or hold a long lease on it |
| Council tax band | A to H; sets a home's yearly local property tax |
| EPC rating | Energy efficiency, from A (best) to G |
| Receptions | Living rooms |
| Position | How ready an applicant is to buy: first-time buyer, cash buyer, has a home to sell first, and so on |
| Chain free | The buyer doesn't need to sell a home first |
| Mortgage agreed in principle | A lender has said it is likely to lend the buyer the money |
