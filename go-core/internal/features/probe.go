package features

// ProbeCapacity uses the active generation's model enablement and load policy.
// Zero means capacity enforcement is disabled; callers still reserve a slot.
func (b *Builder) ProbeCapacity(id string) (int, bool) {
	for _, model := range b.models {
		if model.base.ID == id {
			if !model.base.Enabled {
				return 0, false
			}
			if !b.policy.LoadEnabled {
				return 0, true
			}
			return model.base.Capacity, true
		}
	}
	return 0, false
}
