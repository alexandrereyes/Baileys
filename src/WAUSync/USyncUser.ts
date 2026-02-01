import { trace } from '../Utils/trace-logger'

export class USyncUser {
	id?: string
	lid?: string
	phone?: string
	type?: string
	personaId?: string

	withId(id: string) {
		trace('USyncUser', 'withId', { id })
		this.id = id
		return this
	}

	withLid(lid: string) {
		trace('USyncUser', 'withLid', { lid })
		this.lid = lid
		return this
	}

	withPhone(phone: string) {
		trace('USyncUser', 'withPhone', { phone })
		this.phone = phone
		return this
	}

	withType(type: string) {
		trace('USyncUser', 'withType', { type })
		this.type = type
		return this
	}

	withPersonaId(personaId: string) {
		trace('USyncUser', 'withPersonaId', { personaId })
		this.personaId = personaId
		return this
	}
}
