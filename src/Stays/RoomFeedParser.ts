import { SaxesParser, SaxesTag } from 'saxes'
import { Readable } from 'stream'
import {
  StaysRoom,
  StaysBed,
  StaysBedType,
  StaysAmenity,
  StaysPhoto,
  StaysRoomRate,
} from './StaysTypes'

/**
 * Helper to normalize incoming XML bed strings to StaysBedType
 */
function normalizeBedType(rawType: string): StaysBedType {
  const lower = rawType.toLowerCase()
  if (lower.includes('king')) return 'king'
  if (lower.includes('queen')) return 'queen'
  if (lower.includes('double')) return 'double'
  if (lower.includes('twin')) return 'twin'
  if (lower.includes('sofa')) return 'sofabed'
  if (lower.includes('murphy')) return 'murphy'
  if (lower.includes('bunk')) return 'bunk'
  if (lower.includes('full')) return 'full'
  return 'single' // Fallback default
}

const AMENITY_MAPPING: Record<string, StaysAmenity['type']> = {
  WIFI: 'wifi',
  INTERNET: 'wifi',
  POOL: 'pool',
  SWIMMING: 'pool',
  PARKING: 'parking',
  VALET: 'parking',
  GYM: 'gym',
  FITNESS: 'gym',
  WORKOUT: 'gym',
  SPA: 'spa',
  SAUNA: 'spa',
  RESTAURANT: 'restaurant',
  DINING: 'restaurant',
  ROOMSERVICE: 'room_service',
  LAUNDRY: 'laundry',
  DRYCLEANING: 'laundry',
  CONCIERGE: 'concierge',
  PETS: 'pets_allowed',
  DOG: 'pets_allowed',
  CAT: 'pets_allowed',
  BUSINESS: 'business_centre',
  LOUNGE: 'lounge',
  BAR: 'lounge',
  CHILDCARE: 'childcare_service',
  BABY: 'childcare_service',
  ATM: 'cash_machine',
  CASH: 'cash_machine',
  FRONTDESK: '24_hour_front_desk',
  RECEPTION: '24_hour_front_desk',
  ACCESSIB: 'accessibility_mobility',
  HANDICAP: 'accessibility_mobility',
  HEARING: 'accessibility_hearing',
  ADULT: 'adult_only',
}

function mapAmenity(rawCode: string): StaysAmenity['type'] {
  // Normalize: uppercase, remove non-alphanumeric to match keys like "FRONTDESK"
  const normalized = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '')
  for (const key in AMENITY_MAPPING) {
    if (normalized.includes(key)) {
      return AMENITY_MAPPING[key]
    }
  }
  return 'wifi' // Fallback default required by strict type union
}

export class HotelRoomFeedParser {
  private parser: SaxesParser
  private stream: Readable

  constructor(stream: Readable) {
    this.stream = stream
    this.parser = new SaxesParser()
  }

  /**
   * Parses the stream and invokes the callback for each complete room found.
   * Returns a promise that resolves when the stream is finished.
   */
  public parse(onRoomFound: (room: StaysRoom, sourceId?: string, hotelId?: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      // State management
      let currentHotelId: string | undefined
      let currentRoom: Partial<StaysRoom> | null = null
      let currentRate: Partial<StaysRoomRate> | null = null
      let currentSourceId: string | undefined
      let currentTag: string | null = null
      let textBuffer = ''

      this.parser.on('error', (err) => {
        reject(err)
      })

      this.parser.on('opentag', (tag: SaxesTag) => {
        currentTag = tag.name
        textBuffer = '' // Reset text buffer for new tag

        // 0. Detect Hotel Context (for bulk feeds)
        if (tag.name === 'Hotel' || tag.name === 'HotelDescriptiveContent' || tag.name === 'Property') {
          currentHotelId = (tag.attributes.HotelCode as string) ||
                           (tag.attributes.HotelID as string) ||
                           (tag.attributes.id as string) ||
                           (tag.attributes.Code as string)
        }

        // 1. Detect start of a Room definition
        // Matches 'GuestRoom' from OrganizationHospitality_4_0_0.xsd
        if (tag.name === 'Room' || tag.name === 'GuestRoom') {
          // Capture Source ID from common attributes
          currentSourceId =
            (tag.attributes.id as string) ||
            (tag.attributes.code as string) ||
            (tag.attributes.RoomTypeCode as string) ||
            (tag.attributes.RoomID as string)

          currentRoom = {
            name: (tag.attributes.roomTypeName as string) || (tag.attributes.name as string) || '',
            rates: [], // Initialize mandatory array
            beds: [],
            photos: [],
            amenities: [],
            attributes: {},
          }

          // Map attributes from GuestRoom tag
          const maxOcc = tag.attributes.maxOccupancy || tag.attributes.MaxOccupancy
          if (maxOcc) {
            currentRoom.max_occupancy = parseInt(maxOcc as string, 10)
          }
        }

        // 2. Handle nested objects if we are inside a room
        if (currentRoom) {
          // Example: <Bed type="King" count="1" />
          if (tag.name === 'Bed') {
            const type = normalizeBedType((tag.attributes.type as string) || '')
            const count = parseInt((tag.attributes.count as string) || '1', 10)
            currentRoom.beds?.push({ type, count })
          }

          // Handle TypeRoom specific attributes if name wasn't found on GuestRoom
          if (tag.name === 'TypeRoom') {
             const typeName = tag.attributes.name as string
             const typeCode = tag.attributes.RoomTypeCode as string || tag.attributes.code as string

             if (typeName && !currentRoom.name) currentRoom.name = typeName
             // If we didn't find an ID on the parent tag, try to get it here
             if (typeCode && !currentSourceId) currentSourceId = typeCode
          }

          // Example: <Photo url="http://..." />
          if (tag.name === 'Photo' || tag.name === 'Image') {
            const url = (tag.attributes.url as string) || (tag.attributes.src as string)
            if (url) currentRoom.photos?.push({ url })
          }

          // Example: <Amenity code="WIFI">Free Wifi</Amenity>
          if (tag.name === 'Amenity') {
            const code = (tag.attributes.code as string) || ''
            // We push a placeholder; description will be filled in 'text' event or 'closetag'
            // Mapping 'type' often requires a lookup table based on amenity codes
            currentRoom.amenities?.push({
              type: mapAmenity(code),
              description: '',
            })
          }

          // 3. Detect start of Rate/RatePlan
          if (tag.name === 'Rate' || tag.name === 'RatePlan') {
            currentRate = {
              id: (tag.attributes.id as string) || `rate_${Math.random().toString(36).substr(2, 9)}`,
              code: (tag.attributes.code as string) || null,
              // Defaults for mandatory fields
              total_amount: '0.00',
              total_currency: 'USD',
              base_amount: null,
              base_currency: 'USD',
              tax_amount: null,
              tax_currency: 'USD',
              fee_amount: null,
              fee_currency: 'USD',
              due_at_accommodation_amount: null,
              due_at_accommodation_currency: 'USD',
              payment_type: 'pay_now',
              board_type: 'room_only',
              available_payment_methods: ['card'],
              conditions: [],
              cancellation_timeline: [],
              loyalty_programme_required: false,
              supported_loyalty_programme: null,
              source: 'duffel_hotel_group',
              expires_at: new Date(Date.now() + 86400000).toISOString(), // Default +1 day
              description: null,
              quantity_available: null,
            }
          }
        }
      })

      this.parser.on('text', (text: string) => {
        if (!currentRoom) return
        textBuffer += text
      })

      this.parser.on('closetag', (tag: SaxesTag) => {
        if (!currentRoom) return

        const content = textBuffer.trim()

        // Handle Hotel closing
        if (tag.name === 'Hotel' || tag.name === 'HotelDescriptiveContent' || tag.name === 'Property') {
          currentHotelId = undefined
        }

        // Handle Rate closing and fields
        if (currentRate) {
          if (tag.name === 'Rate' || tag.name === 'RatePlan') {
            currentRoom.rates?.push(currentRate as StaysRoomRate)
            currentRate = null
            currentTag = null
            return
          }

          if (tag.name === 'Amount' || tag.name === 'Total') {
            currentRate.total_amount = content
            if (tag.attributes.currency) {
              const currency = tag.attributes.currency as string
              currentRate.total_currency = currency
              currentRate.base_currency = currency
              currentRate.tax_currency = currency
              currentRate.fee_currency = currency
              currentRate.due_at_accommodation_currency = currency
            }
          } else if (tag.name === 'Meals' || tag.name === 'Board') {
            const lower = content.toLowerCase()
            if (lower.includes('breakfast')) currentRate.board_type = 'breakfast'
            else if (lower.includes('all')) currentRate.board_type = 'all_inclusive'
          }
        }

        // 3. Map text content to Room fields
        if (tag.name === 'Name' || tag.name === 'RoomName') {
          currentRoom.name = content
        } else if (tag.name === 'MaxOccupancy') {
          currentRoom.max_occupancy = parseInt(content, 10)
        } else if (tag.name === 'Description') {
          // If you had a description field
        } else if (tag.name === 'BedType') {
          // OTM/OTA style: <BedType>King</BedType>
          // We aggregate these. If we see "King", we check if we already have a King bed and increment count, else add new.
          const type = normalizeBedType(content)
          const existingBed = currentRoom.beds?.find(b => b.type === type)
          if (existingBed) {
            existingBed.count++
          } else {
            currentRoom.beds?.push({ type, count: 1 })
          }
        } else if (tag.name === 'RoomCategory') {
          // Maps to attributes.class (e.g. Standard, Deluxe)
          if (!currentRoom.attributes) currentRoom.attributes = {}
          currentRoom.attributes.class = content
        } else if (tag.name === 'RoomView') {
          // Maps to attributes.view (e.g. Ocean View)
          if (!currentRoom.attributes) currentRoom.attributes = {}
          currentRoom.attributes.view = content
        } else if (tag.name === 'RoomAmenity') {
          // OTM style: <DescriptiveContentAmenity><RoomAmenity>WIFI</RoomAmenity></DescriptiveContentAmenity>
          // We treat the text content as the amenity code/description
          if (content) {
            currentRoom.amenities?.push({
              type: mapAmenity(content),
              description: content
            })
          }
        } else if (tag.name === 'Amenity') {
          // Update the last added amenity with the text description
          const lastAmenity = currentRoom.amenities?.[currentRoom.amenities.length - 1]
          if (lastAmenity) {
            lastAmenity.description = content
          }
        }

        // 4. Detect end of Room definition and emit
        if (tag.name === 'Room' || tag.name === 'GuestRoom') {
          // Ensure mandatory fields are present
          if (currentRoom.name) {
            onRoomFound(currentRoom as StaysRoom, currentSourceId, currentHotelId)
          }
          currentRoom = null
          currentSourceId = undefined
        }

        currentTag = null
      })

      this.parser.on('end', () => resolve())

      // Pipe the stream to the parser
      this.stream.on('data', (chunk) => this.parser.write(chunk))
      this.stream.on('end', () => this.parser.close())
      this.stream.on('error', (err) => reject(err))
    })
  }
}