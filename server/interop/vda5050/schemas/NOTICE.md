The files in `2.0.0/` are the JSON schemas published with VDA 5050 version
2.0.0 (https://github.com/VDA5050/VDA5050, tag `2.0.0`, commit
a8974b1f8bc412f72cca237f14c5578fe1b01224, folder `json_schemas/`), copied
unchanged. They are under the MIT licence in `LICENSE.txt` (Verband der
Automobilindustrie).

Two defects in the published 2.0.0 schema files, and what HANNAH does about
them (server/interop/vda5050/schema.js):

1. `factsheet.json` lists its fields at the top level instead of under
   `properties`, so as published it constrains nothing but `required`. HANNAH
   reads those top-level field schemas as `properties` when it validates a
   factsheet.
2. `instantActions.schema` requires `actionName` in each action, while the
   specification text (section 6.9, which refers to the action object of
   section 6.6/6.7) and the order schema use `actionType`. Release 2.1.0
   changed the schema to `actionType`. HANNAH sends both fields with the same
   value, so a message satisfies the 2.0.0 schema file and the specification.
