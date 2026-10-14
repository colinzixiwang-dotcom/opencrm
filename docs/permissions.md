# Managing permissions

Sign in as administrator. Open **Settings → Role permissions → Add role**. Give it a name/key, then select pages and the actions allowed on each page. Save. Open **Users & roles** to create a user with that role, or use **Assign roles** for multiple roles.

The user receives the union of enabled roles' grants. For example, a Catalog Clerk can have Product page + `product.create` while lacking `product.update`. A second read-only Analyst role adds the other pages without granting their writes. Disabling Catalog Clerk removes its create grant even while that user remains logged in. Server requests use current database grants; refresh an already-open browser to update visible controls.

**Menus & buttons** lets an administrator rename/reorder menus and change visibility/enabled state. Hidden means omitted from navigation while the permission remains usable. Disabled removes that specific grant. Page and button permissions are independent; disabling a page does not disable every child action automatically. The role editor handles page/child selection together for normal assignment.

Administrator is protected and has wildcard access. Unknown actions are denied. Invalid role/menu IDs and invalid assignments roll back. The server prevents self-removal of administrator access and removal of the last enabled administrator. Account disablement invalidates its authenticated requests immediately.

All modules share reference product/warehouse/company data for document selection. Business collections, reporting, exports, user/role lists and mutations are checked separately. There are no department data scopes, field-level redaction policies, row ownership scopes, or tenants. This permission system should not be interpreted as those features.

RuoYi-style `/api/getInfo` and `/api/getRouters` return roles, permission codes, and navigation entries for the React client. The app also uses `/api/bootstrap` for its consolidated workspace data. These are Harbor endpoints, not a claim of complete compatibility with every RuoYi API.
