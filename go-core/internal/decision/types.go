// Package decision implements the versioned, deterministic Auto selection kernel.
// Classification and token estimates are inputs, not silently reimplemented rules.
package decision

type Analysis struct {
	Task                   string          `json:"task"`
	SubTask                string          `json:"subTask"`
	Tier                   string          `json:"tier"`
	Complexity             float64         `json:"complexity"`
	EstimatedContextTokens float64         `json:"estimatedContextTokens"`
	Requirements           map[string]bool `json:"requirements"`
}

type Preference struct {
	Model     string  `json:"model"`
	Tolerance float64 `json:"tolerance"`
}

// Policy contains resolved numeric defaults from a validated configuration.
// Absence and zero are resolved by the versioned adapter, never by Go zero values.
type Policy struct {
	ScoreStrategy           string      `json:"scoreStrategy"`
	Mode                    string      `json:"mode"`
	ShadowModel             string      `json:"shadowModel"`
	AutoModelID             string      `json:"autoModelId"`
	ActiveTrafficPercent    float64     `json:"activeTrafficPercent"`
	QualityFloor            float64     `json:"qualityFloor"`
	QualityWeight           float64     `json:"qualityWeight"`
	CostWeight              float64     `json:"costWeight"`
	ProviderCostWeight      float64     `json:"providerCostWeight"`
	LatencyWeight           float64     `json:"latencyWeight"`
	PreferSelfHosted        bool        `json:"preferSelfHosted"`
	SelfHostedBonus         float64     `json:"selfHostedBonus"`
	UncertaintyPenalty      float64     `json:"uncertaintyPenalty"`
	ComplexQualityMargin    float64     `json:"complexQualityMargin"`
	RelativeQualityCap      float64     `json:"relativeQualityCap"`
	AllowQualityDegradation bool        `json:"allowQualityDegradation"`
	CostTier                string      `json:"costTier"`
	SubtaskSmoothK          float64     `json:"subtaskSmoothK"`
	SubtaskMinSamples       float64     `json:"subtaskMinSamples"`
	SubtaskMaxAdjust        float64     `json:"subtaskMaxAdjust"`
	LatencyScaleMs          float64     `json:"latencyScaleMs"`
	LatencyMax              float64     `json:"latencyMax"`
	ErrorStep               float64     `json:"errorStep"`
	ErrorMax                float64     `json:"errorMax"`
	BudgetCostMultiplier    float64     `json:"budgetCostMultiplier"`
	BudgetDegradeThreshold  float64     `json:"budgetDegradeThreshold"`
	LoadEnabled             bool        `json:"loadEnabled"`
	LoadPenaltyWeight       float64     `json:"loadPenaltyWeight"`
	ReasoningEnabled        bool        `json:"reasoningEnabled"`
	ReasoningHighMin        float64     `json:"reasoningHighMin"`
	ReasoningOffMax         float64     `json:"reasoningOffMax"`
	Preference              *Preference `json:"preference"`
}

type Subscore struct {
	Average float64 `json:"average"`
	Samples float64 `json:"samples"`
}

type Model struct {
	ID                      string          `json:"id"`
	Enabled                 bool            `json:"enabled"`
	Ownership               string          `json:"ownership"`
	Capabilities            map[string]bool `json:"capabilities"`
	ContextWindow           float64         `json:"contextWindow"`
	Quality                 float64         `json:"quality"`
	Subscore                *Subscore       `json:"subscore"`
	CostIndex               float64         `json:"costIndex"`
	ProviderCostIndex       float64         `json:"providerCostIndex"`
	LatencyIndex            float64         `json:"latencyIndex"`
	ReliabilityVerified     bool            `json:"reliabilityVerified"`
	Capacity                int             `json:"capacity"`
	MinimumCompletionTokens float64         `json:"minimumCompletionTokens"`
	VerifiedThinkingOff     bool            `json:"verifiedThinkingOff"`
	ReasoningParameter      string          `json:"reasoningParameter"`
	ReasoningValues         map[string]any  `json:"reasoningValues"`
	ReasoningVerified       bool            `json:"reasoningVerified"`
}

type Health struct {
	CircuitOpenUntil    float64 `json:"circuitOpenUntil"`
	EWMALatencyMs       float64 `json:"ewmaLatencyMs"`
	ConsecutiveFailures float64 `json:"consecutiveFailures"`
}

type Runtime struct {
	NowMs             float64            `json:"nowMs"`
	TrafficBucket     float64            `json:"trafficBucket"`
	BudgetPressure    float64            `json:"budgetPressure"`
	AllowedModelIDs   *[]string          `json:"allowedModelIds"`
	Health            map[string]Health  `json:"health"`
	Inflight          map[string]int     `json:"inflight"`
	MarketAdjustments map[string]float64 `json:"marketAdjustments"`
}

type Input struct {
	SchemaVersion     int      `json:"schemaVersion"`
	ConfigVersion     string   `json:"configVersion"`
	RequestedModel    string   `json:"requestedModel"`
	CompletionTokens  float64  `json:"completionTokens"`
	ThinkingSpecified bool     `json:"thinkingSpecified"`
	ThinkingOff       bool     `json:"thinkingOff"`
	Analysis          Analysis `json:"analysis"`
	Policy            Policy   `json:"policy"`
	Models            []Model  `json:"models"`
	Runtime           Runtime  `json:"runtime"`
}

type Load struct {
	Inflight    int      `json:"inflight"`
	Capacity    *int     `json:"capacity"`
	Utilization *float64 `json:"utilization"`
	Scope       string   `json:"scope"`
	Penalty     float64  `json:"penalty"`
	Saturated   bool     `json:"saturated"`
}

type Candidate struct {
	Model                 string  `json:"model"`
	Quality               float64 `json:"quality"`
	Score                 float64 `json:"score"`
	BaseScore             float64 `json:"baseScore"`
	MarketAdjust          float64 `json:"marketAdjust"`
	CostIndex             float64 `json:"costIndex"`
	QualityQualified      bool    `json:"qualityQualified"`
	QualityEligible       bool    `json:"qualityEligible"`
	QualityLoss           float64 `json:"qualityLoss"`
	EffectiveQualityFloor float64 `json:"effectiveQualityFloor"`
	Load                  Load    `json:"load"`
}

type Rejection struct {
	Model   string   `json:"model"`
	Reasons []string `json:"reasons"`
}

type Rollout struct {
	ActiveTrafficPercent float64 `json:"activeTrafficPercent"`
	TrafficBucket        float64 `json:"trafficBucket"`
	RolloutApplied       bool    `json:"rolloutApplied"`
	SafetyOverride       string  `json:"safetyOverride,omitempty"`
}

type Decision struct {
	SchemaVersion     int         `json:"schemaVersion"`
	ConfigVersion     string      `json:"configVersion"`
	RequestedModel    string      `json:"requestedModel"`
	SelectedModel     string      `json:"selectedModel"`
	SuggestedModel    string      `json:"suggestedModel"`
	ReasoningLevel    string      `json:"reasoningLevel"`
	Shadow            bool        `json:"shadow"`
	Rollout           Rollout     `json:"rollout"`
	Candidates        []Candidate `json:"candidates"`
	Rejected          []Rejection `json:"rejected"`
	FallbackOrder     []string    `json:"fallbackOrder"`
	QualifiedModelIDs []string    `json:"qualifiedModelIds"`
	QualityDegraded   bool        `json:"qualityDegraded"`
	PreferenceApplied bool        `json:"preferenceApplied"`
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Message }

func failure(code, message string) *Error { return &Error{Code: code, Message: message} }
