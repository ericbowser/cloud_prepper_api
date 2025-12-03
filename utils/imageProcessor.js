const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;

/**
 * Process and optimize uploaded avatar image
 * @param {string} filePath - Path to uploaded image
 * @param {number} size - Desired output size (square)
 * @returns {Promise<string>} - Path to processed image
 */
async function processAvatar(filePath, size = 200) {
    try {
        const ext = path.extname(filePath);
        const dir = path.dirname(filePath);
        const filename = path.basename(filePath, ext);
        const outputPath = path.join(dir, `${filename}_processed.webp`);

        // Process image: resize, crop to square, optimize
        await sharp(filePath)
            .resize(size, size, {
                fit: 'cover',
                position: 'center'
            })
            .webp({ quality: 85 })
            .toFile(outputPath);

        // Delete original file
        await fs.unlink(filePath);

        return outputPath;
    } catch (error) {
        console.error('Error processing avatar:', error);
        throw new Error('Failed to process image');
    }
}

/**
 * Delete old avatar file
 * @param {string} avatarUrl - Relative URL to avatar
 */
async function deleteOldAvatar(avatarUrl) {
    if (!avatarUrl) return;
    
    try {
        const fullPath = path.join(__dirname, '..', avatarUrl);
        await fs.unlink(fullPath);
        console.log('Deleted old avatar:', fullPath);
    } catch (error) {
        // Ignore errors if file doesn't exist
        console.log('Could not delete old avatar:', error.message);
    }
}

module.exports = {
    processAvatar,
    deleteOldAvatar
};
