Vendored from https://github.com/zither/cnlunar-js at commit
`b7daa47198f7370c4f75d43be1667407f164c4f2` (package version 0.2.0), 2026-09-28.
Upstream: https://github.com/OPN48/cnlunar. MIT license is preserved in LICENSE.

Local modification: lunar.js imports a module-local CivilDate in place of the
ambient Date. Its civil-date arithmetic uses UTC getters/constructors, without
changing the application's timezone. The service supplies a fixed noon date,
validates table boundaries, and does not expose hourly fortune calculations.
Rules and data otherwise remain upstream's; this is not a certified transcription
of the entire 协纪辨方书. Do not edit rules without comparison fixtures and provenance.
