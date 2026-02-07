/**
 * Category Taxonomy for CloudPrepper
 * 
 * This module defines the standardized category structure for exam questions.
 * Categories are mapped to domains to ensure proper organization and validation.
 */

// Standard categories mapped to CompTIA Cloud+ domains
const DOMAIN_CATEGORY_MAP = {
  'Cloud Architecture and Design': [
    'Architecture Patterns',
    'Service Models',
    'High Availability',
    'Disaster Recovery',
    'Network Design',
    'Storage Architecture',
    'Scalability & Elasticity'
  ],
  'Cloud Deployment': [
    'Deployment Strategies',
    'Migration',
    'Capacity Planning',
    'Infrastructure as Code',
    'Containerization',
    'Deployment Models'
  ],
  'Cloud Operations and Support': [
    'Monitoring & Logging',
    'Performance Optimization',
    'Backup & Recovery',
    'Resource Management',
    'Automation & Orchestration',
    'Operations'
  ],
  'Cloud Security': [
    'Identity & Access Management',
    'Data Security',
    'Network Security',
    'Compliance & Governance',
    'Security Monitoring'
  ],
  'DevOps Fundamentals': [
    'CI/CD Pipelines',
    'Source Control',
    'Configuration Management',
    'Testing & Validation',
    'Release Management'
  ],
  'Troubleshooting': [
    'Performance Troubleshooting',
    'Network Troubleshooting',
    'Security Troubleshooting',
    'Integration Issues'
  ]
};

// Flat list of all valid categories
const ALL_CATEGORIES = Object.values(DOMAIN_CATEGORY_MAP).flat();

/**
 * Get valid categories for a specific domain
 * @param {string} domain - Domain name
 * @returns {string[]} Array of valid category names
 */
function getCategoriesForDomain(domain) {
  return DOMAIN_CATEGORY_MAP[domain] || [];
}

/**
 * Get domain for a category
 * @param {string} category - Category name
 * @returns {string|null} Domain name or null if not found
 */
function getDomainForCategory(category) {
  for (const [domain, categories] of Object.entries(DOMAIN_CATEGORY_MAP)) {
    if (categories.includes(category)) {
      return domain;
    }
  }
  return null;
}

/**
 * Validate if a category is valid for a domain
 * @param {string} category - Category to validate
 * @param {string} domain - Domain to check against
 * @returns {boolean} True if valid
 */
function isValidCategoryForDomain(category, domain) {
  const validCategories = getCategoriesForDomain(domain);
  return validCategories.includes(category);
}

/**
 * Find closest matching category using fuzzy matching
 * @param {string} input - Input category string
 * @param {string[]} validCategories - List of valid categories to match against
 * @returns {string} Closest matching category
 */
function findClosestCategory(input, validCategories) {
  if (!input || !validCategories || validCategories.length === 0) {
    return 'Operations'; // Default fallback
  }

  const inputLower = input.toLowerCase();
  
  // Exact match (case insensitive)
  for (const cat of validCategories) {
    if (cat.toLowerCase() === inputLower) {
      return cat;
    }
  }

  // Keyword matching - map common terms to standard categories
  const keywordMap = {
    // Monitoring
    'monitor': 'Monitoring & Logging',
    'logging': 'Monitoring & Logging',
    'alert': 'Monitoring & Logging',
    'observability': 'Monitoring & Logging',
    'metric': 'Monitoring & Logging',
    
    // CI/CD
    'ci': 'CI/CD Pipelines',
    'cd': 'CI/CD Pipelines',
    'pipeline': 'CI/CD Pipelines',
    'continuous': 'CI/CD Pipelines',
    'integration': 'CI/CD Pipelines',
    'delivery': 'CI/CD Pipelines',
    'deployment': 'Deployment Strategies',
    
    // Backup
    'backup': 'Backup & Recovery',
    'recovery': 'Backup & Recovery',
    'restore': 'Backup & Recovery',
    'snapshot': 'Backup & Recovery',
    
    // Security
    'security': 'Identity & Access Management',
    'iam': 'Identity & Access Management',
    'identity': 'Identity & Access Management',
    'access': 'Identity & Access Management',
    'auth': 'Identity & Access Management',
    'compliance': 'Compliance & Governance',
    'governance': 'Compliance & Governance',
    'encryption': 'Data Security',
    
    // Performance
    'performance': 'Performance Optimization',
    'optimization': 'Performance Optimization',
    'tuning': 'Performance Optimization',
    'scaling': 'Scalability & Elasticity',
    'autoscaling': 'Scalability & Elasticity',
    'elasticity': 'Scalability & Elasticity',
    
    // Architecture
    'architecture': 'Architecture Patterns',
    'design': 'Architecture Patterns',
    'pattern': 'Architecture Patterns',
    'availability': 'High Availability',
    'ha': 'High Availability',
    'disaster': 'Disaster Recovery',
    'dr': 'Disaster Recovery',
    
    // Networking
    'network': 'Network Design',
    'vpc': 'Network Design',
    'subnet': 'Network Design',
    'routing': 'Network Design',
    
    // Storage
    'storage': 'Storage Architecture',
    'volume': 'Storage Architecture',
    'disk': 'Storage Architecture',
    
    // Migration
    'migration': 'Migration',
    'migrate': 'Migration',
    
    // Automation
    'automation': 'Automation & Orchestration',
    'orchestration': 'Automation & Orchestration',
    'script': 'Automation & Orchestration',
    
    // Containers
    'container': 'Containerization',
    'docker': 'Containerization',
    'kubernetes': 'Containerization',
    'k8s': 'Containerization',
    
    // DevOps
    'devops': 'CI/CD Pipelines',
    'git': 'Source Control',
    'version': 'Source Control',
    
    // Troubleshooting
    'troubleshoot': 'Performance Troubleshooting',
    'debug': 'Performance Troubleshooting',
    
    // Cost
    'cost': 'Resource Management',
    'budget': 'Resource Management',
    'pricing': 'Resource Management',
    
    // Capacity
    'capacity': 'Capacity Planning',
    'planning': 'Capacity Planning'
  };

  // Check keywords
  for (const [keyword, category] of Object.entries(keywordMap)) {
    if (inputLower.includes(keyword) && validCategories.includes(category)) {
      return category;
    }
  }

  // If no keyword match, use first valid category for the domain
  return validCategories[0] || 'Operations';
}

/**
 * Legacy category mapping for migration
 * Maps old fragmented categories to new standardized categories
 */
const LEGACY_CATEGORY_MAP = {
  // Monitoring variants
  'Monitoring and Alerting': 'Monitoring & Logging',
  'Performance Monitoring': 'Monitoring & Logging',
  'Operations - Monitoring': 'Monitoring & Logging',
  'Performance Monitoring and Troubleshooting': 'Monitoring & Logging',
  'Cloud Monitoring and Logging': 'Monitoring & Logging',
  'Monitoring': 'Monitoring & Logging',
  'Cloud Observability': 'Monitoring & Logging',
  
  // CI/CD variants
  'CI/CD Pipeline Implementation': 'CI/CD Pipelines',
  'CI/CD Pipeline Optimization': 'CI/CD Pipelines',
  'CI/CD Pipeline Management': 'CI/CD Pipelines',
  'CI/CD Pipeline Design': 'CI/CD Pipelines',
  'CI/CD Pipelines': 'CI/CD Pipelines',
  'CI/CD Pipeline': 'CI/CD Pipelines',
  'CI/CD Pipeline Maturity': 'CI/CD Pipelines',
  'CI/CD Pipeline Maturity Assessment': 'CI/CD Pipelines',
  'CI/CD Pipeline Maturity and Governance': 'CI/CD Pipelines',
  'CI/CD Pipeline Design and Deployment Strategies': 'CI/CD Pipelines',
  'CI/CD Pipeline Design and Maturity Assessment': 'CI/CD Pipelines',
  'CI/CD Pipeline Design and Optimization': 'CI/CD Pipelines',
  'CI/CD Pipelines and Source Control': 'CI/CD Pipelines',
  'DevOps - CI/CD': 'CI/CD Pipelines',
  'Continuous Integration': 'CI/CD Pipelines',
  'Continuous Integration and Continuous Delivery': 'CI/CD Pipelines',
  'Continuous Integration and Version Control': 'Source Control',
  
  // Backup variants
  'Backup and Recovery': 'Backup & Recovery',
  'Backup & Recovery': 'Backup & Recovery',
  'Backup Types': 'Backup & Recovery',
  'Backup Types and Strategies': 'Backup & Recovery',
  'Backup Validation': 'Backup & Recovery',
  'Cloud Backup Strategies': 'Backup & Recovery',
  'Backup and Recovery Strategies': 'Backup & Recovery',
  'Backup and Restore Operations': 'Backup & Recovery',
  'Disaster Recovery': 'Disaster Recovery',
  'Cloud Operations - Disaster Recovery': 'Disaster Recovery',
  'Cloud Architecture - Disaster Recovery': 'Disaster Recovery',
  'Business Continuity': 'Disaster Recovery',
  'Cloud Business Continuity': 'Disaster Recovery',
  'Business Impact Analysis': 'Disaster Recovery',
  
  // Security variants
  'Security': 'Identity & Access Management',
  'Cloud Security - Access Management': 'Identity & Access Management',
  'Cloud Security - Authentication': 'Identity & Access Management',
  'Identity and Access Management': 'Identity & Access Management',
  'Cloud Identity Management': 'Identity & Access Management',
  'Cloud Security and Compliance': 'Compliance & Governance',
  'Compliance': 'Compliance & Governance',
  'Compliance Deployment': 'Compliance & Governance',
  'Compliance and Governance': 'Compliance & Governance',
  'Cloud Compliance': 'Compliance & Governance',
  'Cloud Security - Compliance Automation': 'Compliance & Governance',
  'Cloud Security - Data Governance': 'Data Security',
  'Cloud Security - Vulnerability Management': 'Security Monitoring',
  'Cloud Security - API Management': 'Identity & Access Management',
  
  // Performance variants
  'Performance Troubleshooting': 'Performance Troubleshooting',
  'Performance Optimization': 'Performance Optimization',
  'Cloud Performance Optimization': 'Performance Optimization',
  'Troubleshooting and Performance Optimization': 'Performance Troubleshooting',
  'Troubleshooting': 'Performance Troubleshooting',
  'Cloud Troubleshooting - Performance': 'Performance Troubleshooting',
  'Cloud Troubleshooting - Network': 'Network Troubleshooting',
  'Cloud Troubleshooting - Security': 'Security Troubleshooting',
  'Cloud Troubleshooting - Integration': 'Integration Issues',
  'Cloud Troubleshooting - VDI': 'Performance Troubleshooting',
  
  // Architecture variants
  'Cloud Architecture': 'Architecture Patterns',
  'Cloud Architecture and Design': 'Architecture Patterns',
  'Cloud Design Principles': 'Architecture Patterns',
  'Architecture - High Availability': 'High Availability',
  'Cloud Architecture - Availability': 'High Availability',
  'Cloud Architecture - Design Patterns': 'Architecture Patterns',
  'Cloud Architecture - Service Models': 'Service Models',
  'Cloud Service Models': 'Service Models',
  'Cloud Architecture - Scaling Strategies': 'Scalability & Elasticity',
  'Cloud Scaling': 'Scalability & Elasticity',
  'Rightsizing and Auto-scaling': 'Scalability & Elasticity',
  
  // Networking variants
  'Networking': 'Network Design',
  'Network Connectivity': 'Network Design',
  'Hybrid Cloud Connectivity': 'Network Design',
  'Cloud Network Architecture': 'Network Design',
  'Cloud Architecture - Networking': 'Network Design',
  'Cloud Architecture - Network Components': 'Network Design',
  'Container Technologies - Networking': 'Network Design',
  
  // Storage variants
  'Storage': 'Storage Architecture',
  'Cloud Storage Concepts': 'Storage Architecture',
  'Cloud Architecture - Storage': 'Storage Architecture',
  
  // Deployment variants
  'Deployment': 'Deployment Strategies',
  'Deployment Strategies': 'Deployment Strategies',
  'Deployment Models': 'Deployment Models',
  'Cloud Deployment Models': 'Deployment Models',
  'Cloud Architecture - Deployment Models': 'Deployment Models',
  
  // Migration variants
  'Cloud Migration': 'Migration',
  'Cloud Migration and Capacity Planning': 'Migration',
  
  // Automation variants
  'Automation': 'Automation & Orchestration',
  'Cloud Automation and Orchestration': 'Automation & Orchestration',
  
  // Containers variants
  'Containers': 'Containerization',
  'Container Technologies': 'Containerization',
  'Container Management': 'Containerization',
  'Container Orchestration': 'Containerization',
  'Container Orchestration and Deployment Strategies': 'Containerization',
  'Container Orchestration and High Availability': 'Containerization',
  'Cloud Architecture - Containers': 'Containerization',
  
  // Operations variants
  'Operations': 'Operations',
  'Cloud Operations': 'Operations',
  'Operations - Log Management': 'Monitoring & Logging',
  
  // Cost/Resource variants
  'Cost Management': 'Resource Management',
  'Cloud Cost Management': 'Resource Management',
  'Cloud Financial Management': 'Resource Management',
  'CapEx vs OpEx': 'Resource Management',
  'Cost Optimization - Serverless vs Container Economics': 'Resource Management',
  
  // Capacity variants
  'Capacity Planning': 'Capacity Planning',
  
  // IaC variants
  'Infrastructure as Code': 'Infrastructure as Code',
  
  // Other
  'Cloud Concepts': 'Service Models',
  'API Management': 'Identity & Access Management',
  'Content Delivery': 'Network Design',
  'Change Management': 'Operations'
};

/**
 * Map a legacy category to its standardized equivalent
 * @param {string} legacyCategory - Old category name
 * @returns {string} Standardized category name
 */
function mapLegacyCategory(legacyCategory) {
  return LEGACY_CATEGORY_MAP[legacyCategory] || legacyCategory;
}

module.exports = {
  DOMAIN_CATEGORY_MAP,
  ALL_CATEGORIES,
  LEGACY_CATEGORY_MAP,
  getCategoriesForDomain,
  getDomainForCategory,
  isValidCategoryForDomain,
  findClosestCategory,
  mapLegacyCategory
};
