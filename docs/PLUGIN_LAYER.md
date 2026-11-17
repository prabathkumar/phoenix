# Plugin layer for testing industry products

Phoenix tests business products (SAP, Salesforce, Microsoft Dynamics 365, Odoo, SuiteCRM, OTOBO, OTRS and more) through a **plugin layer**. The framework does not hard-code any product. For each product there is a specialised agent; the agent calls the product's plugin, and the plugin does the job.

Code: `backend/phoenix_api/product_plugins.py`. API: `GET /api/plugins`, `POST /api/plugins/{id}/run`. UI: **Plugin layer** page. Tests: `backend/tests/test_product_plugins.py`.

## What a plugin provides
| Part | What it does |
|---|---|
| Manifest | id, name, vendor, family, the server settings it needs (`<PREFIX>_BASE_URL`, keys), **plugin version** and the **product versions it supports** |
| Sign-in | OAuth client credentials (Salesforce, Dynamics 365, SuiteCRM), API key (Odoo), Basic or bearer (SAP), session (OTOBO, OTRS). Credentials come from the server's environment, never from a request |
| Objects and calls | The product's own entities (Account, Lead, Business Partner, Sales Order, Ticket, res.partner...) with JSON schemas |
| Test data | Valid, boundary, invalid and hostile values made from those schemas by the same engine as the API layer |
| Scenarios | Product-aware business flows for the AI to turn into cases (order to cash, lead to opportunity, ticket lifecycle...) |
| Version probe | Reads the running product's version |

## Modes (`mode` in the run call)
- `plan`: cases and scenarios, nothing is sent to the product.
- `functional`: the cases are fired at the product. Writes run only with `allowWrites`; invalid-data cases always run because a good product rejects them.
- `readback`: creates one record tagged `PHOENIX-TEST`, reads it back, compares, removes it where the API allows (OTOBO and OTRS cannot delete).
- `security`: calls without credentials and with a bad token must be refused; no stack traces, SQL or runtime errors in error bodies; https only.
- `perf`: read-only calls and a Locust file that reads its token from `PRODUCT_TOKEN` at run time.

## When the product upgrades, the plugin upgrades
Each plugin has its own version and the range of product versions it was written for. Every run reads the product's version and says `ok`, `newer`, `older` or `unknown`. A `newer` or `older` product marks the result **stale** ("Upgrade the Odoo plugin") so a pass on a product the plugin was not written for is never taken at face value. Supporting a new product release means releasing a new plugin version (for example an Odoo 17/18 plugin using `/jsonrpc` beside the Odoo 19 one using `/json/2`).

## Plugins today
| Plugin | Product versions declared | Notes |
|---|---|---|
| Salesforce | API 60.0 to 65.0 | Account, Contact, Lead, Case. OAuth client credentials |
| Microsoft Dynamics 365 | 9.2 | accounts, contacts, leads, incidents (Dataverse Web API) |
| SAP S/4HANA (OData) | not declared | Business Partner, Sales Order, Purchase Order. **Read-only**: writes need an X-CSRF-Token from a response header and the shared HTTP seam does not return headers yet |
| Odoo (JSON-2) | 19.0 | res.partner, crm.lead, sale.order. Readback not built |
| SuiteCRM 8 | not declared | Accounts, Contacts, Leads, Cases |
| OTOBO, OTRS | not declared | Ticket create and read through a GenericInterface web service (name set by the administrator) |

## Not proven
No plugin has been run against a real product. The call shapes, paths, version ranges and token endpoints are from the vendors' documented APIs as I know them and must be confirmed against a sandbox of each product before the results are trusted. Each product also needs its own test user with least privilege; do not point a plugin with write access at production.
