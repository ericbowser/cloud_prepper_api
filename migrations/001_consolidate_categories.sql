-- Migration: Consolidate Categories
-- Date: 2026-02-06
-- Purpose: Reduce 286 fragmented categories to 25 standardized categories
-- 
-- This migration maps existing categories to standardized categories using the
-- LEGACY_CATEGORY_MAP from utils/category_taxonomy.js

BEGIN;

-- Create a backup table first
CREATE TABLE IF NOT EXISTS prepper.comptia_cloud_plus_questions_backup_20260206 AS 
SELECT * FROM prepper.comptia_cloud_plus_questions;

-- Update categories using mapping
-- Monitoring variants
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Monitoring & Logging'
WHERE category IN (
  'Monitoring and Alerting',
  'Performance Monitoring',
  'Operations - Monitoring',
  'Performance Monitoring and Troubleshooting',
  'Cloud Monitoring and Logging',
  'Monitoring',
  'Cloud Observability',
  'Operations - Log Management'
);

-- CI/CD variants
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'CI/CD Pipelines'
WHERE category IN (
  'CI/CD Pipeline Implementation',
  'CI/CD Pipeline Optimization',
  'CI/CD Pipeline Management',
  'CI/CD Pipeline Design',
  'CI/CD Pipelines',
  'CI/CD Pipeline',
  'CI/CD Pipeline Maturity',
  'CI/CD Pipeline Maturity Assessment',
  'CI/CD Pipeline Maturity and Governance',
  'CI/CD Pipeline Design and Deployment Strategies',
  'CI/CD Pipeline Design and Maturity Assessment',
  'CI/CD Pipeline Design and Optimization',
  'DevOps - CI/CD',
  'Continuous Integration',
  'Continuous Integration and Continuous Delivery'
);

-- Source Control
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Source Control'
WHERE category IN (
  'CI/CD Pipelines and Source Control',
  'Continuous Integration and Version Control'
);

-- Backup & Recovery variants
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Backup & Recovery'
WHERE category IN (
  'Backup and Recovery',
  'Backup & Recovery',
  'Backup Types',
  'Backup Types and Strategies',
  'Backup Validation',
  'Cloud Backup Strategies',
  'Backup and Recovery Strategies',
  'Backup and Restore Operations'
);

-- Disaster Recovery variants
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Disaster Recovery'
WHERE category IN (
  'Disaster Recovery',
  'Cloud Operations - Disaster Recovery',
  'Cloud Architecture - Disaster Recovery',
  'Business Continuity',
  'Cloud Business Continuity',
  'Business Impact Analysis'
);

-- Identity & Access Management variants
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Identity & Access Management'
WHERE category IN (
  'Security',
  'Cloud Security - Access Management',
  'Cloud Security - Authentication',
  'Identity and Access Management',
  'Cloud Identity Management',
  'Cloud Security - API Management',
  'API Management'
);

-- Compliance & Governance variants
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Compliance & Governance'
WHERE category IN (
  'Cloud Security and Compliance',
  'Compliance',
  'Compliance Deployment',
  'Compliance and Governance',
  'Cloud Compliance',
  'Cloud Security - Compliance Automation'
);

-- Data Security
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Data Security'
WHERE category IN (
  'Cloud Security - Data Governance'
);

-- Security Monitoring
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Security Monitoring'
WHERE category IN (
  'Cloud Security - Vulnerability Management'
);

-- Performance Troubleshooting
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Performance Troubleshooting'
WHERE category IN (
  'Performance Troubleshooting',
  'Troubleshooting and Performance Optimization',
  'Troubleshooting',
  'Cloud Troubleshooting - Performance',
  'Cloud Troubleshooting - VDI'
);

-- Network Troubleshooting
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Network Troubleshooting'
WHERE category IN (
  'Cloud Troubleshooting - Network'
);

-- Security Troubleshooting
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Security Troubleshooting'
WHERE category IN (
  'Cloud Troubleshooting - Security'
);

-- Integration Issues
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Integration Issues'
WHERE category IN (
  'Cloud Troubleshooting - Integration'
);

-- Performance Optimization
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Performance Optimization'
WHERE category IN (
  'Performance Optimization',
  'Cloud Performance Optimization'
);

-- Architecture Patterns
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Architecture Patterns'
WHERE category IN (
  'Cloud Architecture',
  'Cloud Architecture and Design',
  'Cloud Design Principles',
  'Cloud Architecture - Design Patterns'
);

-- High Availability
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'High Availability'
WHERE category IN (
  'Architecture - High Availability',
  'Cloud Architecture - Availability',
  'Container Orchestration and High Availability'
);

-- Service Models
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Service Models'
WHERE category IN (
  'Cloud Architecture - Service Models',
  'Cloud Service Models',
  'Cloud Concepts'
);

-- Scalability & Elasticity
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Scalability & Elasticity'
WHERE category IN (
  'Cloud Architecture - Scaling Strategies',
  'Cloud Scaling',
  'Rightsizing and Auto-scaling'
);

-- Network Design
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Network Design'
WHERE category IN (
  'Networking',
  'Network Connectivity',
  'Hybrid Cloud Connectivity',
  'Cloud Network Architecture',
  'Cloud Architecture - Networking',
  'Cloud Architecture - Network Components',
  'Container Technologies - Networking',
  'Content Delivery'
);

-- Storage Architecture
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Storage Architecture'
WHERE category IN (
  'Storage',
  'Cloud Storage Concepts',
  'Cloud Architecture - Storage'
);

-- Deployment Strategies
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Deployment Strategies'
WHERE category IN (
  'Deployment',
  'Deployment Strategies',
  'Container Orchestration and Deployment Strategies'
);

-- Deployment Models
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Deployment Models'
WHERE category IN (
  'Deployment Models',
  'Cloud Deployment Models',
  'Cloud Architecture - Deployment Models'
);

-- Migration
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Migration'
WHERE category IN (
  'Cloud Migration',
  'Cloud Migration and Capacity Planning'
);

-- Capacity Planning
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Capacity Planning'
WHERE category IN (
  'Capacity Planning'
);

-- Infrastructure as Code
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Infrastructure as Code'
WHERE category IN (
  'Infrastructure as Code'
);

-- Automation & Orchestration
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Automation & Orchestration'
WHERE category IN (
  'Automation',
  'Cloud Automation and Orchestration'
);

-- Containerization
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Containerization'
WHERE category IN (
  'Containers',
  'Container Technologies',
  'Container Management',
  'Container Orchestration',
  'Cloud Architecture - Containers'
);

-- Operations
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Operations'
WHERE category IN (
  'Operations',
  'Cloud Operations',
  'Change Management'
);

-- Resource Management
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Resource Management'
WHERE category IN (
  'Cost Management',
  'Cloud Cost Management',
  'Cloud Financial Management',
  'CapEx vs OpEx',
  'Cost Optimization - Serverless vs Container Economics'
);

-- Configuration Management
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Configuration Management'
WHERE category IN (
  'Configuration Management'
);

-- Testing & Validation
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Testing & Validation'
WHERE category IN (
  'Testing & Validation'
);

-- Release Management
UPDATE prepper.comptia_cloud_plus_questions 
SET category = 'Release Management'
WHERE category IN (
  'Release Management'
);

-- Verify results
SELECT 
  category,
  COUNT(*) as question_count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
FROM prepper.comptia_cloud_plus_questions
GROUP BY category
ORDER BY question_count DESC;

-- Report summary
SELECT 
  'Total Questions' as metric,
  COUNT(*)::text as value
FROM prepper.comptia_cloud_plus_questions
UNION ALL
SELECT 
  'Unique Categories',
  COUNT(DISTINCT category)::text
FROM prepper.comptia_cloud_plus_questions
UNION ALL
SELECT
  'Backup Table Created',
  'prepper.comptia_cloud_plus_questions_backup_20260206';

COMMIT;

-- Rollback script (if needed):
-- BEGIN;
-- DROP TABLE IF EXISTS prepper.comptia_cloud_plus_questions;
-- ALTER TABLE prepper.comptia_cloud_plus_questions_backup_20260206 RENAME TO comptia_cloud_plus_questions;
-- COMMIT;
