import { Readable } from 'stream'
import { HotelRoomFeedParser } from './RoomFeedParser'
import { StaysRoom } from './StaysTypes'

describe('HotelRoomFeedParser', () => {
  it('should parse a simple room with beds and amenities (Attribute Style)', async () => {
    const xml = `
      <Hotels>
        <GuestRoom name="Deluxe King" maxOccupancy="2" RoomTypeCode="DK123">
          <Bed type="King" count="1" />
          <Amenity code="WIFI">Free High Speed Wi-Fi</Amenity>
          <Photo url="http://example.com/room.jpg" />
        </GuestRoom>
      </Hotels>
    `
    const stream = Readable.from([xml])
    const parser = new HotelRoomFeedParser(stream)
    const rooms: StaysRoom[] = []
    const ids: string[] = []

    await parser.parse((room, id) => {
      rooms.push(room)
      if (id) ids.push(id)
    })

    expect(rooms).toHaveLength(1)
    expect(rooms[0].name).toBe('Deluxe King')
    expect(ids[0]).toBe('DK123')
    expect(rooms[0].max_occupancy).toBe(2)
    expect(rooms[0].beds).toEqual([{ type: 'king', count: 1 }])
    expect(rooms[0].amenities).toEqual([
      { type: 'wifi', description: 'Free High Speed Wi-Fi' },
    ])
    expect(rooms[0].photos).toEqual([{ url: 'http://example.com/room.jpg' }])
  })

  it('should handle OTM style attributes and nested elements (Element Style)', async () => {
    const xml = `
      <Hotel>
        <Room>
          <TypeRoom name="Ocean View Suite" RoomTypeCode="OVS_99" />
          <MaxOccupancy>4</MaxOccupancy>
          <RoomCategory>Suite</RoomCategory>
          <RoomView>Ocean</RoomView>
          <!-- Multiple BedType elements should aggregate -->
          <BedType>Queen</BedType>
          <BedType>Queen</BedType>
          <DescriptiveContentAmenity>
            <RoomAmenity>POOL</RoomAmenity>
          </DescriptiveContentAmenity>
        </Room>
      </Hotel>
    `
    const stream = Readable.from([xml])
    const parser = new HotelRoomFeedParser(stream)
    const rooms: StaysRoom[] = []
    const ids: string[] = []

    await parser.parse((room, id) => {
      rooms.push(room)
      if (id) ids.push(id)
    })

    expect(rooms).toHaveLength(1)
    expect(rooms[0].name).toBe('Ocean View Suite')
    expect(ids[0]).toBe('OVS_99')
    expect(rooms[0].max_occupancy).toBe(4)
    expect(rooms[0].attributes?.class).toBe('Suite')
    expect(rooms[0].attributes?.view).toBe('Ocean')
    
    // Should aggregate two Queens into count: 2
    expect(rooms[0].beds).toEqual([{ type: 'queen', count: 2 }])
    
    // Should map POOL to 'pool' type
    expect(rooms[0].amenities).toEqual([
      { type: 'pool', description: 'POOL' },
    ])
  })

  it('should fallback to wifi for unknown amenities', async () => {
    const xml = `
      <Room>
        <Name>Standard</Name>
        <Amenity code="UNKNOWN_THING">Some Feature</Amenity>
      </Room>
    `
    const stream = Readable.from([xml])
    const parser = new HotelRoomFeedParser(stream)
    const rooms: StaysRoom[] = []

    await parser.parse((room) => rooms.push(room))
    
    expect(rooms[0].amenities?.[0].type).toBe('wifi')
    expect(rooms[0].amenities?.[0].description).toBe('Some Feature')
  })

  it('should parse rates within a room', async () => {
    const xml = `
      <GuestRoom name="Standard">
        <RatePlan code="BAR" id="rate_123">
          <Total currency="GBP">150.00</Total>
          <Meals>Breakfast Included</Meals>
        </RatePlan>
        <RatePlan code="RO" id="rate_456">
          <Total currency="GBP">100.00</Total>
          <Meals>Room Only</Meals>
        </RatePlan>
      </GuestRoom>
    `
    const stream = Readable.from([xml])
    const parser = new HotelRoomFeedParser(stream)
    const rooms: StaysRoom[] = []

    await parser.parse((room) => rooms.push(room))

    expect(rooms[0].rates).toHaveLength(2)
    expect(rooms[0].rates[0].total_amount).toBe('150.00')
    expect(rooms[0].rates[0].total_currency).toBe('GBP')
    expect(rooms[0].rates[0].board_type).toBe('breakfast')
    expect(rooms[0].rates[1].board_type).toBe('room_only')
  })

  it('should extract parent hotel ID for bulk feeds', async () => {
    const xml = `
      <Hotels>
        <Hotel HotelCode="H100">
          <GuestRoom RoomTypeCode="R1"><Name>Room 1</Name></GuestRoom>
        </Hotel>
        <Hotel HotelCode="H200">
          <GuestRoom RoomTypeCode="R2"><Name>Room 2</Name></GuestRoom>
        </Hotel>
      </Hotels>
    `
    const stream = Readable.from([xml])
    const parser = new HotelRoomFeedParser(stream)
    const results: Array<{ hotelId?: string; roomId?: string }> = []

    await parser.parse((room, sourceId, hotelId) => {
      results.push({ hotelId, roomId: sourceId })
    })

    expect(results).toHaveLength(2)
    expect(results[0].hotelId).toBe('H100')
    expect(results[0].roomId).toBe('R1')
    expect(results[1].hotelId).toBe('H200')
    expect(results[1].roomId).toBe('R2')
  })
})
