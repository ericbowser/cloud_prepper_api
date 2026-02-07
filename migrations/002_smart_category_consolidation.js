/**
 * Smart Category Consolidation Script
 * Uses the category_taxonomy fuzzy matching to consolidate ALL remaining categories
 */

const { connectLocalPostgres } = require('../documentdb/client');
const { DOMAIN_CATEGORY_MAP, getCategoriesForDomain, findClosestCategory, mapLegacyCategory } = require('../utils/category_taxonomy');

async function consolidateCategories() {
  const client = await connectLocalPostgres();
  
  try {
    console.log('Starting smart category consolidation...\n');
    
    // Get all current categories with their domains
    const result = await client.query(`
      SELECT DISTINCT 
        category, 
        domain,
        COUNT(*) as question_count
      FROM prepper.comptia_cloud_plus_questions
      GROUP BY category, domain
      ORDER BY question_count DESC
    `);
    
    const categoriesToUpdate = [];
    let totalUpdates = 0;
    
    console.log(`Found ${result.rows.length} unique category/domain combinations\n`);
    
    // Process each category
    for (const row of result.rows) {
      const currentCategory = row.category;
      const domain = row.domain;
      const count = parseInt(row.question_count);
      
      // First try legacy map
      const legacyMapped = mapLegacyCategory(currentCategory);
      if (legacyMapped !== currentCategory) {
        categoriesToUpdate.push({
          old: currentCategory,
          new: legacyMapped,
          domain: domain,
          count: count,
          method: 'legacy_map'
        });
        totalUpdates += count;
        console.log(`[LEGACY] "${currentCategory}" → "${legacyMapped}" (${count} questions)`);
        continue;
      }
      
      // Get valid categories for this domain
      const validCategories = getCategoriesForDomain(domain);
      if (!validCategories || validCategories.length === 0) {
        console.log(`[SKIP] No valid categories for domain "${domain}"`);
        continue;
      }
      
      // Check if current category is already valid
      if (validCategories.includes(currentCategory)) {
        console.log(`[OK] "${currentCategory}" is valid for "${domain}" (${count} questions)`);
        continue;
      }
      
      // Find closest match using fuzzy matching
      const closest = findClosestCategory(currentCategory, validCategories);
      if (closest !== currentCategory) {
        categoriesToUpdate.push({
          old: currentCategory,
          new: closest,
          domain: domain,
          count: count,
          method: 'fuzzy_match'
        });
        totalUpdates += count;
        console.log(`[FUZZY] "${currentCategory}" → "${closest}" (${count} questions)`);
      }
    }
    
    console.log(`\n\nPreparing to update ${categoriesToUpdate.length} categories affecting ${totalUpdates} questions\n`);
    
    // Ask for confirmation
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const answer = await new Promise(resolve => {
      readline.question('Proceed with updates? (yes/no): ', resolve);
    });
    readline.close();
    
    if (answer.toLowerCase() !== 'yes') {
      console.log('Migration cancelled');
      return;
    }
    
    // Begin transaction
    await client.query('BEGIN');
    
    // Apply updates
    for (const update of categoriesToUpdate) {
      const updateResult = await client.query(`
        UPDATE prepper.comptia_cloud_plus_questions
        SET category = $1
        WHERE category = $2 AND domain = $3
      `, [update.new, update.old, update.domain]);
      
      console.log(`Updated ${updateResult.rowCount} rows: "${update.old}" → "${update.new}"`);
    }
    
    // Commit transaction
    await client.query('COMMIT');
    
    // Show final statistics
    const finalStats = await client.query(`
      SELECT 
        COUNT(DISTINCT category) as unique_categories,
        COUNT(*) as total_questions
      FROM prepper.comptia_cloud_plus_questions
    `);
    
    console.log('\n✅ Migration complete!');
    console.log(`Final unique categories: ${finalStats.rows[0].unique_categories}`);
    console.log(`Total questions: ${finalStats.rows[0].total_questions}`);
    
    // Show category distribution
    const distribution = await client.query(`
      SELECT 
        category,
        COUNT(*) as count,
        ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
      FROM prepper.comptia_cloud_plus_questions
      GROUP BY category
      ORDER BY count DESC
      LIMIT 30
    `);
    
    console.log('\nTop 30 categories after consolidation:');
    for (const row of distribution.rows) {
      console.log(`  ${row.category}: ${row.count} (${row.percentage}%)`);
    }
    
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error during migration:', error);
    throw error;
  }
}

// Run migration
consolidateCategories()
  .then(() => {
    console.log('\nMigration script finished');
    process.exit(0);
  })
  .catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  });
