import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import console from 'console'
import process from 'process'

/**
 * Generates a TypeScript Client SDK from the OpenAPI definition.
 * Usage: ts-node src/scripts/generate_sdk.ts
 */
async function generateSdk() {
  // Adjust paths based on your project structure
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const openApiFile = path.resolve(__dirname, '../Stays/openapi.yaml')
  const outputDir = path.resolve(__dirname, '../../generated-client')

  if (!fs.existsSync(openApiFile)) {
    console.error(`Error: OpenAPI definition not found at ${openApiFile}`)
    process.exit(1)
  }

  console.log('Generating TypeScript Client SDK...')
  try {
    // Using npx to run the generator without global installation
    execSync(`npx @openapitools/openapi-generator-cli generate -i "${openApiFile}" -g typescript-axios -o "${outputDir}" --additional-properties=npmName=@duffel/enterprise-mapping-client,supportsES6=true`, { stdio: 'inherit' })
    console.log(`\nSDK generated successfully in: ${outputDir}`)
  } catch (error) {
    console.error('Failed to generate SDK:', error)
  }
}

generateSdk()
