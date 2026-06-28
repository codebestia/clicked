import { eq, and, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { files } from '../db/schema.js';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { s3Client, S3_BUCKET } from '../lib/s3.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

export async function garbageCollectPendingFiles() {
  try {
    const oneHourAgo = new Date(Date.now() - ONE_HOUR_MS);
    
    // Find unconfirmed pending files older than 1 hour
    const pendingFiles = await db.query.files.findMany({
      where: and(
        eq(files.status, 'pending'),
        lt(files.createdAt, oneHourAgo)
      )
    });

    if (pendingFiles.length === 0) return;

    for (const file of pendingFiles) {
      try {
        // Attempt to delete from S3 just in case the file was uploaded but not confirmed
        const command = new DeleteObjectCommand({
          Bucket: S3_BUCKET,
          Key: file.objectKey,
        });
        await s3Client.send(command).catch(err => {
          console.warn(`Failed to delete object from S3: ${file.objectKey}`, err);
        });

        // Delete from database
        await db.delete(files).where(eq(files.id, file.id));
        
        console.log(`Garbage collected pending file: ${file.id}`);
      } catch (err) {
        console.error(`Error garbage collecting file ${file.id}:`, err);
      }
    }
  } catch (error) {
    console.error('Error in garbage collection:', error);
  }
}

export function startGarbageCollectionCron() {
  // Run every 10 minutes
  setInterval(() => {
    void garbageCollectPendingFiles();
  }, 10 * 60 * 1000);
}
