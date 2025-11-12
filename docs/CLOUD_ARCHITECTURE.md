# Trade Streamer Cloud Architecture (Proposed)

This document captures the reference deployment for hosting Trade Streamer securely in either AWS or GCP. The design keeps compute stateless, pushes all durable state into a managed data plane, and enforces least‑privilege boundaries at every hop.

## 1. High-Level Topology

```
Users (VPN + SSO) ──▶ CDN (CloudFront / Cloud CDN)
                      │
                      ▼
            HTTPS Load Balancer (ALB / Cloud LB + Cloud Armor)
                      │
        ┌─────────────┴─────────────┐
        │                           │
        ▼                           ▼
UI Service (ECS Fargate / Cloud Run)    Background Services (ECS Fargate / Cloud Run Jobs)
        │                           │
        └──────────────┬────────────┘
                       ▼
            Data Plane (DynamoDB Global Tables / Firestore)
                       │
                       ▼
        Object Storage (S3 / Cloud Storage, versioned + encrypted)
                       │
                       ▼
            External APIs (E*TRADE, FMP, Yahoo) via NAT + TLS
```

## 2. Core Components

| Layer | AWS Option | GCP Option | Notes |
| --- | --- | --- | --- |
| Static UI hosting | S3 + CloudFront | Cloud Storage + Cloud CDN | Immutable build artifacts with CSP/HSTS |
| Application runtime | ECS Fargate services (Node UI, scan API) | Cloud Run services | Stateless containers, IAM task/service accounts |
| Async jobs | Fargate scheduled tasks / Lambda | Cloud Run jobs / Cloud Functions | Snapshot feeder, guardian, auto-exit monitor |
| Queueing | SQS + EventBridge Scheduler | Pub/Sub + Cloud Scheduler | Triggers periodic scans and workflows |
| Data plane | DynamoDB global tables | Firestore (multi-region) | Shared state for scans, tracked ideas, auto-exit metadata |
| Object storage | S3 (versioned, SSE-KMS) | Cloud Storage (bucket lock, CMEK) | PDFs, historical snapshots, exports |
| Secrets | Secrets Manager + KMS | Secret Manager + CMEK | Rotated keys for E*TRADE, FMP, AI providers |
| Observability | CloudWatch, X-Ray, GuardDuty | Cloud Monitoring, Cloud Logging, Cloud IDS | Metrics, tracing, threat detection |
| Security perimeter | ALB + AWS WAF, VPC with private subnets + NAT | Cloud Load Balancer + Cloud Armor, VPC Service Controls | Only HTTPS ingress, service-to-service via SG/Firewall rules |

## 3. Request Flow

1. **User access** — Traders authenticate through Google Auth (Workspace) enforced at the CDN/LB layer (Cognito, IAP, Auth0). MFA and domain allowlisting guarantee only approved accounts reach the dashboard.
2. **Static assets** — UI bundle is served from CDN edge nodes; API calls target the regional load balancer.
3. **UI/API service** — Node/Express container (Fargate/Cloud Run) validates JWTs, loads scan data from DynamoDB/Firestore, and proxies controlled broker actions (market buy, emergency sell).
4. **Background services** — Runners (day-trade scanner, snapshot feeder, guardian) run as separate services/cron jobs. They write scan payloads, indicators, and order intents into the data plane and emit events onto queues when auto-exit logic should fire.
5. **Data plane** — DynamoDB/Firestore stores:
   - Scan results + AI metadata (TTL optional for stale data)
   - Portfolio snapshots, tracked ideas, auto-exit cooldowns
   - Audit entries (orders sent, broker responses)
   Each record is encrypted at rest (KMS/CMEK) and mirrored cross-region (global tables or multi-region Firestore).
6. **Auto-exit + market actions** — Workers consume DynamoDB Streams/Firestore triggers to evaluate P&L thresholds and submit orders via the E*TRADE provider. Order history is appended to S3 for long-term compliance.
7. **External APIs** — Outbound calls to E*TRADE, FMP, Yahoo flow through NAT gateways with security groups restricting egress to provider ranges. OAuth credentials stay in Secrets Manager/Secret Manager and are only accessible to the order microservice.

## 4. Multi-Region Strategy

- Deploy identical stacks in two regions (e.g., us-east-1/us-west-2 or `nam5/europe-west4`).
- Use Route 53 latency routing or Cloud DNS geo-policy to direct users to the nearest healthy region; health checks fail over automatically.
- DynamoDB global tables or Firestore multi-region ensure scan data, tracked ideas, and order logs replicate with sub-second lag; object storage buckets use Cross-Region Replication / Dual-Region.
- Secrets Manager / Secret Manager entries are replicated during CI/CD so each region has up-to-date API keys.
- Use IaC (Terraform/CDK/Deployment Manager) to keep infrastructure definitions identical.

## 5. Security Controls

- **Identity & Access**: SSO via Google Auth (OIDC) with MFA; RBAC enforced in-app. All services run with least-privilege IAM roles.
- **Network**: Private subnets for compute/data; ingress limited to HTTPS through WAF/Armor. Outbound broker calls go through NAT with firewall egress rules. Optional VPN/Client VPN for admin access.
- **Secrets and Config**: Managed secret stores with automated rotation; no secrets baked into images. Parameter Store/Config Controller handles non-secret configs.
- **Monitoring**: Centralized logs (CloudWatch Logs/Cloud Logging) with sensitive fields masked. GuardDuty/Cloud IDS for threat detection. Alerts from metrics (scan failures, degraded broker calls, auto-exit errors).
- **Data**: At-rest encryption everywhere (KMS/CMEK). S3/Cloud Storage buckets are private with bucket policies denying public access. Lifecycle policies archive stale scan logs to Glacier/Coldline.
- **Supply Chain**: CI/CD builds signed Docker images, scans with Trivy/Artifact Registry scanning, and deploys via GitHub OIDC or Cloud Build with least privilege.

## 6. Operations & Cost Notes

- Use Fargate Spot (or Cloud Run min instances = 0) for background services to cut idle costs.
- Aurora/Firestore backups + DynamoDB PITR cover disaster recovery; run periodic restore tests.
- Enable autoscaling on ECS/Cloud Run based on CPU/memory plus custom metrics (queue depth, scan latency).
- Prefetch broker data judiciously to avoid API throttles; cache ephemeral data in DynamoDB with TTL or Memorystore/ElastiCache if needed.

## 7. Next Steps

1. Finalize IaC templates for both AWS and GCP targets.
2. Stand up lower environments (dev/staging) in separate accounts/projects with identical guardrails.
3. Implement end-to-end canary tests (UI → scan → order) to validate deployments.
4. Document retention/archival policies for regulatory artifacts (orders, AI prompts, logs).

This architecture keeps Trader Streamer portable (AWS ↔ GCP), secure, and ready for multi-region growth without managing servers or databases manually.
