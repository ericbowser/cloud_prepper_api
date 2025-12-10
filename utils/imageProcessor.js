const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;

// Define the directory where all avatars are stored. Adjust as needed for your config!
const AVATARS_ROOT = path.resolve(__dirname, '..', 'uploads', 'avatars');

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

        // Delete original file, only if in avatars directory
        const resolved = path.resolve(filePath);
        if (resolved.startsWith(AVATARS_ROOT + path.sep)) {
            await fs.unlink(resolved);
        } else {
            throw new Error('Attempt to delete file outside avatar directory');
        }

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
        const fullPath = path.resolve(__dirname, '..', avatarUrl);
        if (fullPath.startsWith(AVATARS_ROOT + path.sep)) {
            await fs.unlink(fullPath);
            console.log('Deleted old avatar:', fullPath);
        } else {
            throw new Error('Attempt to delete file outside avatar directory');
        }
    } catch (error) {
        // Ignore errors if file doesn't exist
        console.log('Could not delete old avatar:', error.message);
    }
}

module.exports = {
    processAvatar,
    deleteOldAvatar
};
