# Canary Release Process for HANNAH Desktop

## Cohorts
- 5% of desktop users receive the new build first.
- The remaining 95% stay on stable.

## Metrics
- Crash rate.
- Error rate.
- Update failure rate.
- Session duration.

## Rollback
- If error rate exceeds 1.5x baseline for 30 minutes, stop rollout.
- Publish a fixed release with a higher version number.
- Do not reuse the failed version.
