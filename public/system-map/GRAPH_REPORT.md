# Graph Report - .  (2026-07-28)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 3844 nodes · 9168 edges · 315 communities (189 shown, 126 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 195 edges (avg confidence: 0.51)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `a8e33d1e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 104
- Community 105
- Community 106
- Community 107
- Community 108
- Community 109
- Community 110
- Community 111
- Community 112
- Community 113
- Community 114
- Community 115
- Community 116
- Community 117
- Community 118
- Community 119
- Community 120
- Community 121
- Community 122
- Community 123
- Community 124
- Community 125
- Community 126
- Community 127
- Community 128
- Community 129
- Community 130
- Community 131
- Community 132
- Community 133
- Community 134
- Community 135
- Community 136
- Community 137
- Community 139
- Community 140
- Community 141
- Community 142
- Community 143
- Community 144
- Community 145
- Community 146
- Community 147
- Community 148
- Community 151
- Community 152
- Community 153
- Community 156
- Community 157
- Community 158
- Community 159
- Community 161
- Community 162
- Community 163
- Community 164
- Community 165
- Community 166
- Community 168
- Community 169
- Community 170
- Community 171
- Community 172
- Community 173
- Community 174
- Community 175
- Community 176
- Community 177
- Community 178
- Community 179
- Community 180
- Community 181
- Community 182
- Community 183
- Community 184
- Community 185
- Community 186
- Community 188
- Community 189
- Community 190
- Community 191
- Community 192
- Community 196
- Community 197
- Community 198
- Community 199
- Community 200
- Community 201
- Community 202
- Community 204
- Community 206
- Community 208
- Community 209
- Community 210
- Community 211
- Community 212
- Community 213
- Community 214
- Community 215
- Community 216
- Community 217
- Community 218
- Community 219
- Community 220
- Community 221
- Community 222
- Community 223
- Community 224
- Community 226
- Community 230
- Community 232
- Community 233
- Community 234
- Community 235
- Community 236
- Community 237
- Community 238
- Community 241
- Community 242
- Community 243
- Community 244
- Community 245
- Community 246
- Community 247
- Community 248
- Community 249
- Community 252
- Community 253
- Community 254
- Community 255
- Community 258
- Community 259
- Community 260
- Community 261
- Community 262
- Community 263
- Community 264
- Community 265
- Community 266
- Community 267
- Community 269
- Community 270
- Community 272
- Community 273
- Community 274
- Community 275
- Community 276
- Community 277
- Community 278

## God Nodes (most connected - your core abstractions)
1. `an()` - 61 edges
2. `va` - 56 edges
3. `ns()` - 55 edges
4. `s()` - 53 edges
5. `normalizeInlineText()` - 51 edges
6. `toSafeString()` - 51 edges
7. `processReceiptImageEvent()` - 50 edges
8. `a()` - 49 edges
9. `o()` - 47 edges
10. `l()` - 43 edges

## Surprising Connections (you probably didn't know these)
- `findCatalogProductsByPriceRange()` --indirect_call--> `a()`  [INFERRED]
  src/db.js → public/vendor/chart.umd.min.js
- `extractQueryCandidatesFromOcrText()` --indirect_call--> `a()`  [INFERRED]
  src/server.js → public/vendor/chart.umd.min.js
- `listMarkdownFiles()` --indirect_call--> `b()`  [INFERRED]
  scripts/generate-knowledge-system.mjs → public/vendor/chart.umd.min.js
- `findCatalogProductsByPriceRange()` --indirect_call--> `b()`  [INFERRED]
  src/db.js → public/vendor/chart.umd.min.js
- `extractQueryCandidatesFromOcrText()` --indirect_call--> `b()`  [INFERRED]
  src/server.js → public/vendor/chart.umd.min.js

## Import Cycles
- 3-file cycle: `supabase/functions/_shared/receipt_parse.ts -> supabase/functions/_shared/store_receipt_phones.ts -> supabase/functions/_shared/store_receipt.ts -> supabase/functions/_shared/receipt_parse.ts`

## Communities (315 total, 126 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.03
Nodes (34): beforeDatasetDraw(), beforeDatasetsDraw(), d(), destroy(), Di(), es(), fe(), getMaxOverflow() (+26 more)

### Community 1 - "Community 1"
Cohesion: 0.02
Nodes (106): addIngestionError(), attachAliases(), buildProductWritePayload(), completeIngestionFile(), countIngestionErrorsByFileStmt, countIngestionProductSnapshotsByFileStmt, countPriceHistoryByIngestionFileStmt, createIngestionFile() (+98 more)

### Community 2 - "Community 2"
Cohesion: 0.02
Nodes (77): addDaysIso(), AI_USAGE_CLAUDE_STORE_KEYS, AiUsageProviderBucket, AiUsageStoreRow, AppError, authenticate(), authenticateRawAdminToken(), backfillLineUserPermissionsFromMessages() (+69 more)

### Community 3 - "Community 3"
Cohesion: 0.04
Nodes (84): adjustProductStockQty(), adjustProductStockQtyTx, findCurrentPricesByQuery(), getActiveReplyTemplateByKey(), getAdminTokenOverride(), renderTemplate(), saveOcrResult(), app (+76 more)

### Community 4 - "Community 4"
Cohesion: 0.05
Nodes (80): allergyLabel(), buildReservationRow(), buildTodayReservationCalendarUrl(), buildTodayReservationFlex(), DbClient, formatReservationCustomerName(), formatTargetMonth(), handleTestSend() (+72 more)

### Community 5 - "Community 5"
Cohesion: 0.07
Nodes (79): BudgetComparable, budgetComparableEqual(), budgetComparableFromRow(), budgetComparableFromSheetRow(), BudgetRow, budgetRowStoreKeyIndex(), buildBudgetOperatingDaysSheetUpdates(), buildBudgetSheetRowUpdatesFromDb() (+71 more)

### Community 6 - "Community 6"
Cohesion: 0.06
Nodes (17): addBox(), addElements(), afterDatasetsUpdate(), an(), configure(), fs(), generateLabels(), ke() (+9 more)

### Community 7 - "Community 7"
Cohesion: 0.07
Nodes (58): a(), aa(), ai(), ao(), average(), beforeDraw(), cn(), da() (+50 more)

### Community 8 - "Community 8"
Cohesion: 0.09
Nodes (60): asJson(), buildRedirectUrl(), buildResumeImmediateAckText(), buildResumeLineAcceptedText(), callLineBotInfo(), callLineMessageQuota(), callLineWebhookEndpointInfo(), callLineWebhookTest() (+52 more)

### Community 9 - "Community 9"
Cohesion: 0.07
Nodes (18): Ae(), afterDraw(), afterEvent(), afterUpdate(), ba, Bi(), f(), gs() (+10 more)

### Community 10 - "Community 10"
Cohesion: 0.08
Nodes (62): buildAllFeaturesGuideFlex(), buildGroupSalesDatePromptFlex(), buildGroupSalesSearchGuideFlex(), buildGroupSalesSearchGuideText(), buildKindPromptFlex(), buildSearchEntryReply(), buildSearchMenuFlex(), buildSearchMenuFooter() (+54 more)

### Community 11 - "Community 11"
Cohesion: 0.05
Nodes (44): AdvancedStats, avg(), BackRow, BIG_EVTYPES, CiEntry, cohensD(), computeAdvancedStats(), dayOfYear() (+36 more)

### Community 12 - "Community 12"
Cohesion: 0.07
Nodes (56): pushLineMessages(), pushLineText(), buildFlexInfoCard(), buildLineFlexBlueHeader(), flexButton(), FlexButtonAction, FlexButtonSpec, lineSafeFlexText() (+48 more)

### Community 13 - "Community 13"
Cohesion: 0.06
Nodes (14): As(), at(), beforeUpdate(), buildTicks(), go(), ii(), initialize(), labelColor() (+6 more)

### Community 14 - "Community 14"
Cohesion: 0.08
Nodes (47): buildDailySalesConfirmFlex(), buildDailySalesImportedFlex(), buildDailySalesSummaryRows(), buildDailySalesTemplateDownloadFlex(), buildReservationConfirmFlex(), buildReservationImportDetailJson(), buildReservationRegisteredFlex(), buildReservationUpdatedFlex() (+39 more)

### Community 15 - "Community 15"
Cohesion: 0.07
Nodes (50): assertReservationEventMatchesStoreScope(), buildCalendarVisitMonthLabel(), buildCalendarVisitTimeLabel(), buildJstMonthRange(), buildReservationCalendarItem(), buildReservationCountDedupeKey(), buildReservationEffectiveSummaryLookup(), buildReservationNameSearchPatterns() (+42 more)

### Community 16 - "Community 16"
Cohesion: 0.05
Nodes (27): Be(), bo, _calculateBarIndexPixels(), _calculateBarValuePixels(), determineDataLimits(), ea(), et(), getLabelAndValue() (+19 more)

### Community 17 - "Community 17"
Cohesion: 0.06
Nodes (47): buildDailyLogsContext(), buildFoodCourtCompareFlex(), buildFoodCourtDashboardLink(), buildFoodCourtPageUrl(), buildLoopFeedback(), EXTRACT_PROMPT, FC_CODE_TO_NAME, FC_DOW (+39 more)

### Community 18 - "Community 18"
Cohesion: 0.11
Nodes (42): addDaysIsoUtc(), fetchAnalyticsMonthly(), fetchDistinctRoomIdsFromRawTable(), fetchManualMonthsForYearState(), fetchReceiptDailyAggForRange(), fetchReceiptSalesState(), fetchReceiptStoreOptions(), fetchReceiptWebhookStatus() (+34 more)

### Community 19 - "Community 19"
Cohesion: 0.06
Nodes (13): beforeLayout(), buildLookupTable(), En, Fo(), _generate(), getDecimalForValue(), _getTimestampsForTable(), init() (+5 more)

### Community 20 - "Community 20"
Cohesion: 0.17
Nodes (43): answerFoodCourtQuestion(), appendLoopFeedback(), buildAnomalyDays(), buildBaseInsights(), buildCompetitorContext(), buildConditionPatternStats(), buildContributionDecomposition(), buildDailyLogImpactContext() (+35 more)

### Community 21 - "Community 21"
Cohesion: 0.11
Nodes (42): buildCorrectionFlexHeader(), buildFieldSelectionPrompt(), buildReceiptCorrectionCancelOnlyFooter(), buildReceiptCorrectionConfirmCancelFooter(), buildUpdatedReceiptFlexReply(), buildValueInputPrompt(), clearPendingCorrection(), clearPendingReceiptCorrection() (+34 more)

### Community 22 - "Community 22"
Cohesion: 0.09
Nodes (34): applySauvageNetSalesAsGrossSales(), clamp01(), computeReceiptHeuristicConfidence(), decodeEscapedUnicodeSequences(), extractPartyGuestCountsFromText(), extractReceiptPrintedHour(), formatJapaneseReceiptDateFromIso(), getJstBusinessDateForReceiptBudget() (+26 more)

### Community 23 - "Community 23"
Cohesion: 0.14
Nodes (40): coerceMaybeJsonObject(), normalizeInlineText(), normalizeLineImageAnalysisResult(), parseFirstJsonObject(), salvageLineImageAnalysisResultFromText(), buildReceiptVisionSystemPrompt(), analyzeExpenseReceiptWithAzureFoundry(), analyzeExpenseReceiptWithGroqScout() (+32 more)

### Community 24 - "Community 24"
Cohesion: 0.08
Nodes (39): appendChunkWithinLimit(), appendWordXmlNodeText(), buildDocumentSnippet(), collectTextNodes(), columnNameToIndex(), compareWordXmlEntry(), compareXlsxWorksheetEntry(), createSignedMediaDownloadUrl() (+31 more)

### Community 25 - "Community 25"
Cohesion: 0.10
Nodes (38): buildAwardsFromHints(), buildDrinkingWindowFromHints(), buildRatingPointsFromHints(), buildSourceUrlLines(), buildWebSummaryContext(), buildWineryHistoryFromHints(), collectAwardHintsFromText(), collectDrinkingWindowHintsFromText() (+30 more)

### Community 26 - "Community 26"
Cohesion: 0.06
Nodes (25): b(), ce(), ct(), de, dt(), g(), ge(), H() (+17 more)

### Community 27 - "Community 27"
Cohesion: 0.10
Nodes (7): ca(), Ci(), Do(), eo(), getBasePixel(), ls, Oe()

### Community 28 - "Community 28"
Cohesion: 0.11
Nodes (33): bearerToken(), constantTimeEqual(), CORS_HEADERS, isAuthorized(), isServiceRoleAuthorized(), canonicalKeepStoreKey(), clearSpreadsheetTabsExceptStores(), clearStoreSheetBudgetTabsAndPushFromDb() (+25 more)

### Community 29 - "Community 29"
Cohesion: 0.11
Nodes (36): buildPettyCashDashboardLink(), buildPettyCashPageUrl(), CANCEL_WORDS, classifyPettyAcct(), clearPending(), confirmFlex(), conversationKey(), defaultPettyRate() (+28 more)

### Community 30 - "Community 30"
Cohesion: 0.08
Nodes (36): asNullableWineField(), asSourceDisplayName(), buildGrapeCompositionFromEvidence(), buildJpyPriceRangeInfo(), buildLineWineReplyFallback(), buildMarketPriceFromHints(), buildSourceSummary(), buildWineAnalysisFallback() (+28 more)

### Community 31 - "Community 31"
Cohesion: 0.10
Nodes (36): analyzePosJournalWithAi(), asAppError(), askPosJournalAi(), buildLineUserPermissionPayload(), fetchManualMonthGross(), fetchManualMonthsForYearState(), fetchPosJournalAiHistory(), fetchPosJournalAiHistoryItem() (+28 more)

### Community 32 - "Community 32"
Cohesion: 0.13
Nodes (32): getJapaneseHolidayDateSet(), JAPANESE_HOLIDAY_ISO_DATES, buildReceiptBudgetComparisonRows(), computeReceiptDailyDiffTotalLikeAnalyticsFooter(), fetchSalesBudgetRow(), formatYenAmount(), formatYenSignedDiff(), loadStoreDayGrossSumForDate() (+24 more)

### Community 33 - "Community 33"
Cohesion: 0.11
Nodes (51): isRecord(), applyProfileDictionaryClassification(), buildReviewExcerpt(), buildStoreReviewProfilePayload(), classifyNearbyWithAI(), compactGoogleRaw(), CompetitorPlaceRow, CompetitorSnapshotRow (+43 more)

### Community 34 - "Community 34"
Cohesion: 0.08
Nodes (16): Bt(), color(), Ee(), Ft(), Gt(), It(), jt(), kt() (+8 more)

### Community 35 - "Community 35"
Cohesion: 0.09
Nodes (34): buildDisplayWidthIndent(), buildReservationHistoryParagraphs(), collectGmailBodyParts(), constantTimeEqual(), countReservationCoreFields(), decodeBase64UrlUtf8(), formatAlignedReservationLine(), formatReservationCountLine() (+26 more)

### Community 36 - "Community 36"
Cohesion: 0.13
Nodes (35): buildSeatNameFromMail(), buildVisitDateTimeFromMail(), captureFirstMatch(), extractLineAfterLabel(), extractQaAnswer(), extractReservationAllergy(), extractReservationHistory(), extractReservationMailDetails() (+27 more)

### Community 37 - "Community 37"
Cohesion: 0.13
Nodes (33): aggregateGroups(), aggregatePeriod(), answerPosJournalAiQuestion(), boundedInteger(), boundedText(), buildDeterministicPosJournalAnalysis(), buildDeterministicPosJournalAnswer(), buildPosJournalAiFacts() (+25 more)

### Community 38 - "Community 38"
Cohesion: 0.09
Nodes (11): bn(), ei(), je(), on(), pn(), qe(), qs(), ti() (+3 more)

### Community 39 - "Community 39"
Cohesion: 0.14
Nodes (31): clearBistrocavacavaSheetDataRowsAndPushFromDb(), formatSheetA1Range(), appendSheetValuesForTab(), appendSyncLog(), buildDailySalesExportRows(), exportBudgetFromDbToBudgetSheet(), exportClosedDatesFromDbToBudgetSheet(), exportPastSalesFromDbToPastSheet() (+23 more)

### Community 40 - "Community 40"
Cohesion: 0.14
Nodes (30): buildReceiptDuplicateConfirmationFlexReply(), capText(), clearPendingReceiptDuplicate(), completePendingDuplicateAndReply(), conversationKey(), formatJapaneseReceiptDateFromIso(), loadPendingReceiptDuplicate(), markPendingReceiptDuplicateAwaitingDateChange() (+22 more)

### Community 41 - "Community 41"
Cohesion: 0.10
Nodes (5): Cs, nn(), os(), sn, xt

### Community 42 - "Community 42"
Cohesion: 0.10
Nodes (31): evaluateFoodCourtAnswer(), loadFoodCourtLearningMemory(), parseLoopEvaluationJson(), recordFoodCourtFallbackEvent(), recordFoodCourtFallbackIfNeeded(), assessFoodCourtEvolutionReadiness(), auditFoodCourtAnswerNumbers(), buildFoodCourtFallbackEvent() (+23 more)

### Community 43 - "Community 43"
Cohesion: 0.07
Nodes (28): better-sqlite3, dotenv, express, dependencies, better-sqlite3, dotenv, express, xlsx (+20 more)

### Community 44 - "Community 44"
Cohesion: 0.10
Nodes (23): buildAlertMessage(), DbClient, dowOf(), PvEvent, resolveStoreLineToken(), sanitizeLineToken(), sendLinePush(), SPORT_ICON (+15 more)

### Community 45 - "Community 45"
Cohesion: 0.13
Nodes (25): amount(), buildPosJournalSummary(), detectPosJournalStoreCode(), firstInt(), FULLWIDTH_MAP, JournalRecord, normalizeWide(), parsePosJournalLzh() (+17 more)

### Community 46 - "Community 46"
Cohesion: 0.16
Nodes (24): bindRememberCheckbox(), clearToken(), clearTokenStorage(), consumeUrlAuthParams(), consumeUrlLoginTicketParam(), consumeUrlTokenParam(), currentAppScope(), exchangeAdminTokenForSession() (+16 more)

### Community 47 - "Community 47"
Cohesion: 0.16
Nodes (25): fetchManualDayBudgetMapForStore(), fetchManualDaySalesMapForStore(), manualDaySalesFromRow(), ManualDaySalesRecord, ManualDaySalesUpsertEntry, normalizeDateInput(), parseOptionalNonNegativeInt(), upsertManualDayBudgetEntries() (+17 more)

### Community 48 - "Community 48"
Cohesion: 0.09
Nodes (23): architectureHash, colors, docsDir, edgeColors, escapeHtml(), escapeXml(), generatedAt, graph (+15 more)

### Community 49 - "Community 49"
Cohesion: 0.17
Nodes (24): buildCacheKey(), enumerateDates(), fetchArchiveRange(), fetchForecastPastDaysWindow(), fetchForecastRange(), fetchOpenMeteoDaily(), fetchOpenMeteoExternal(), fetchOpenMeteoJson() (+16 more)

### Community 50 - "Community 50"
Cohesion: 0.18
Nodes (23): isFullCalendarMonthPeriod(), shiftIsoDateByYears(), appendReceiptReportYoySection(), buildReceiptYoyCompactKvRows(), buildReceiptYoyKvRows(), calendarDaysInMonth(), countInclusiveCalendarDays(), flexBaselineRow() (+15 more)

### Community 51 - "Community 51"
Cohesion: 0.18
Nodes (22): authenticateAdminDashboardSessionToken(), base64UrlEncode(), constantTimeEqualHex(), exchangeAdminDashboardLoginLinkToken(), exchangeRoomConfigLoginLink(), generateOpaqueToken(), hashRoomConfigPassword(), hashToken() (+14 more)

### Community 52 - "Community 52"
Cohesion: 0.16
Nodes (23): fetchJapaneseHolidaySet(), buildFoodcourtReportUri(), buildComparableEndDateForMonth(), buildReceiptAnalyticsDashboardUrlForLine(), computeBudgetDiffs(), computeComparableMonthProgressRatio(), DayAgg, dayOfMonthFromIso() (+15 more)

### Community 53 - "Community 53"
Cohesion: 0.18
Nodes (22): indexLineRoomReceiptSearch(), startCorrectionSession(), buildReceiptSummaryText(), isPlausibleReceiptCount(), looksLikeOcrLatinStoreLabel(), resolveCanonicalStoreDisplayName(), countFromRawOrDb(), currencyFromRawOrDb() (+14 more)

### Community 54 - "Community 54"
Cohesion: 0.15
Nodes (23): claudeChat(), claudeUsageFrom(), exceptionReason(), extractClaudeText(), extractGeminiText(), foodCourtAiChat(), geminiChat(), grokChat() (+15 more)

### Community 55 - "Community 55"
Cohesion: 0.18
Nodes (21): executeSalesSearch(), buildReceiptFlexMessage(), formatCountOrDash(), formatDecimalOrDash(), formatReceiptDateJa(), formatYenOrDash(), kvRow(), sectionTitle() (+13 more)

### Community 56 - "Community 56"
Cohesion: 0.21
Nodes (19): ascii(), BitReader, crc16(), decodeBitLengthDecoder(), decodeDistanceLengths(), decodeLh5(), decodeLiteralLengths(), decodeUnary7() (+11 more)

### Community 57 - "Community 57"
Cohesion: 0.14
Nodes (16): ExtractedTokyoDomeEvent, isWeekdayLabel(), markerCategory(), parseTokyoDomeSchedule(), DbClient, DOME_CITY_HALLS, DomeAiUsage, domeUsageFrom() (+8 more)

### Community 59 - "Community 59"
Cohesion: 0.14
Nodes (19): azureFoundryUsageFrom(), buildFoodCourtAckFlex(), buildFoodCourtDateConfirmFlex(), checkFoodCourtReceiptConsistency(), computeFoodCourtComparison(), extractFoodCourtTenants(), extractFoodCourtTenantsAzureFoundry(), fcMedian() (+11 more)

### Community 60 - "Community 60"
Cohesion: 0.17
Nodes (19): getJapaneseHolidayDateSet(), addCalendarDaysIso(), allocateDailyBudgetsForMonth(), classifySalesBudgetDay(), coerceStoreClosedDatesItems(), DayKind, DOW_TO_KIND, enumerateMonthDates() (+11 more)

### Community 61 - "Community 61"
Cohesion: 0.15
Nodes (20): buildDocumentStoragePath(), buildPosJournalStoragePath(), createPettyCashEntry(), createPettyCashEntryFromReceiptImage(), extractFileExt(), normalizePettyCashReceiptImageMime(), normalizePettyItems(), normalizePettyTaxMode() (+12 more)

### Community 62 - "Community 62"
Cohesion: 0.24
Nodes (17): base64UrlEncodeBytes(), base64UrlEncodeText(), fetchGoogleServiceAccountAccessToken(), pemToArrayBuffer(), signRs256(), addSpreadsheetSheet(), appendSpreadsheetValues(), batchUpdateSpreadsheetValues() (+9 more)

### Community 63 - "Community 63"
Cohesion: 0.19
Nodes (18): fetchLineMessageBinary(), ensureLineRoomDisplayNameFromWebhook(), ensureLineUserDisplayNameFromWebhook(), fetchLineConversationNameByRoomId(), fetchLineConversationNameByUrl(), fetchLineDisplayNameByUrl(), fetchLineDisplayNameByUserId(), isAutoDisplayNamesEnabled() (+10 more)

### Community 64 - "Community 64"
Cohesion: 0.13
Nodes (19): appendReservationHonorific(), buildGmailReservationAlertLinePayload(), buildGmailReservationAlertMessage(), buildGmailReservationFlexAltText(), buildGmailReservationFlexBubble(), buildGmailReservationFlexMessage(), buildGmailReservationFlexMessages(), buildGmailReservationFlexParagraphRow() (+11 more)

### Community 65 - "Community 65"
Cohesion: 0.12
Nodes (19): buildRelaxedGmailAlertQuery(), cleanupTestReservationSeed(), filterUnnotifiedGmailMessageIds(), loadGmailAlertEnv(), markGmailAlertRoomSent(), maybeSendGmailReservationAlerts(), mergeUniqueGmailMessageLists(), parseBooleanEnv() (+11 more)

### Community 66 - "Community 66"
Cohesion: 0.22
Nodes (18): buildReceiptReportFlexMessages(), formatYenAmount(), receiptCountMatchesOperatingDays(), buildJstDateStartUtcIso(), buildReceiptReportTestSchedule(), buildScheduleSliceForKind(), constantTimeEqual(), dispatchReceiptReport() (+10 more)

### Community 67 - "Community 67"
Cohesion: 0.14
Nodes (15): addDaysUtc(), buildWeeklyFlex(), DbClient, dowOf(), EVT_ICON, nextWeekWindow(), pad2(), resolveStoreLineToken() (+7 more)

### Community 68 - "Community 68"
Cohesion: 0.23
Nodes (17): buildSimpleNoticeFlex(), handleDailySalesImportPostback(), processDailySalesFileEvent(), clearDailyReceiptsForMonth(), countExistingReceiptsForDates(), DailySalesImportEntry, DailySalesParseResult, enumerateImportMonthDates() (+9 more)

### Community 69 - "Community 69"
Cohesion: 0.24
Nodes (16): adminApiPath(), adminApiUrl(), getPreferredStoreDisplayLabel(), gmailSharedAdminApiUrl(), lineWebhookLegacyUrl(), lineWebhookPath(), lineWebhookUrl(), listStores() (+8 more)

### Community 72 - "Community 72"
Cohesion: 0.18
Nodes (16): asGroqVisionContentType(), extractSuggestionsFromGroqText(), extractTextFromGeminiResponse(), isLikelyNoiseLine(), isWineFlowEnabledForProvider(), normalizeSummaryField(), parseJsonObjectFromText(), renderLineWineReplyWithGroq() (+8 more)

### Community 73 - "Community 73"
Cohesion: 0.16
Nodes (16): extractGmailBodyText(), extractGmailHeader(), extractReservationMailDetailsWithGroq(), fetchGmailAccessTokenByRefreshToken(), fetchGmailMessageAlert(), hasAnyReservationMailDetails(), inferReservationEventLabel(), isSupportedReservationRoute() (+8 more)

### Community 74 - "Community 74"
Cohesion: 0.31
Nodes (14): amount(), decode_lzh(), first_int(), main(), parse_file(), parse_sale(), parse_settlement(), parse_weather() (+6 more)

### Community 75 - "Community 75"
Cohesion: 0.30
Nodes (14): bulkDeleteNonKeepSalesRows(), canonicalKey(), clearStoreSales(), clearStoreSheetTabs(), countTable(), del(), deleteDummySeedData(), dryRun (+6 more)

### Community 76 - "Community 76"
Cohesion: 0.25
Nodes (14): BUDGET_NOTICE_LINES, budgetConfirmFlex(), budgetDoneFlex(), budgetFlex(), CANCEL_WORDS, clearPending(), commitBudgetAndReply(), conversationKey() (+6 more)

### Community 78 - "Community 78"
Cohesion: 0.20
Nodes (11): buildAlertFlexMessage(), checkCompetitorReviewAndAlert(), checkStoreReviewAndAlert(), CompetitorPlaceRow, DbClient, flexSafeText(), logReviewAlertCheck(), PlaceCheckResult (+3 more)

### Community 79 - "Community 79"
Cohesion: 0.19
Nodes (6): public.get_room_overview(), public.%I, public.line_room_calendar_events, public.line_room_message_tables, public.line_room_messages_search, public.search_line_room_messages()

### Community 80 - "Community 80"
Cohesion: 0.19
Nodes (7): public.insert_line_room_media_search(), public.line_room_calendar_search, public.line_room_document_search, public.line_room_media_search, public.line_room_receipt_search, public.search_line_room_calendar_events(), public.search_line_room_document_search()

### Community 81 - "Community 81"
Cohesion: 0.17
Nodes (11): collectFiles(), errors, exists(), gitStatus, knowledgeManifestPath, manifestPath, projectDir, requiredRepoFiles (+3 more)

### Community 82 - "Community 82"
Cohesion: 0.31
Nodes (12): closedDaysFromBudget(), deleteAllHocbn(), fetchAll(), hocbnKey, insertBatch(), jhpmKey, main(), mapBudgetRow() (+4 more)

### Community 83 - "Community 83"
Cohesion: 0.18
Nodes (10): args, includeGenerated, limit, limitArg, matchingExcerpt(), normalize(), query, results (+2 more)

### Community 84 - "Community 84"
Cohesion: 0.18
Nodes (13): addPriceHistory(), addPriceTx, upsertCatalogProduct(), upsertCatalogProductTx, asDate(), asPositiveInt(), hasValue(), looksLikeNumericCell() (+5 more)

### Community 85 - "Community 85"
Cohesion: 0.22
Nodes (10): LABEL_SET, MARUGO_GROUP_STORE_OPTIONS, STORE_COORDINATES, extractLatinLettersLower(), levenshtein(), RECEIPT_LATIN_BRAND_PROFILES, resolveBestStoreName(), sortedLatinFingerprint() (+2 more)

### Community 86 - "Community 86"
Cohesion: 0.35
Nodes (12): buildReceiptReportAggregateFromRows(), buildReceiptReportAggregateWithDailyOverrides(), loadReceiptReportAggregateForRoom(), loadReceiptReportAggregateForStoreByReceiptDate(), loadReceiptRowsFromStoreTable(), loadStoreReceiptTableMap(), normalizeConfiguredStorePartitionKey(), receiptDateIsoFromValue() (+4 more)

### Community 87 - "Community 87"
Cohesion: 0.32
Nodes (12): AutoLinkBatchSummary, autoLinkDetectedRoomsForStore(), AutoLinkRoomResult, buildAutoLinkRoomDefaults(), clearRoomDismissed(), ensureRoomAutoLinkedToStore(), isAutoLinkEnabled(), isReceiptRoomAutoLinkEnabled() (+4 more)

### Community 88 - "Community 88"
Cohesion: 0.31
Nodes (12): buildReceiptStoreMismatchFlexReply(), buildStoreMismatchGuidanceText(), capText(), clearPendingStoreNameMismatch(), conversationKey(), formatJapaneseReceiptDateFromIso(), kvRow(), loadLegacyPendingStoreNameMismatch() (+4 more)

### Community 89 - "Community 89"
Cohesion: 0.32
Nodes (11): audit_events, current_prices, ingestion_errors, ingestion_files, line_events, line_reply_templates, ocr_results, price_history (+3 more)

### Community 90 - "Community 90"
Cohesion: 0.20
Nodes (12): buildGlobalSettingsPayload(), buildRoomConfigSafePayload(), buildRoomSettingsPayload(), fetchMediaUploadMaxMb(), GMAIL_ALERT_INTERVAL_MINUTES_ALLOWED, normalizeHours(), normalizeLastDeliverySummaryMode(), normalizeMediaUploadMaxMb() (+4 more)

### Community 91 - "Community 91"
Cohesion: 0.20
Nodes (12): buildReservationCalendarDetailPayload(), buildReservationDetailLabel(), formatReservationHistoryForLine(), inferReservationTypeLabel(), isIkyuReservationRoute(), maybeAccumulatePartnerVisitHistory(), normalizeCalendarDetailText(), normalizeCalendarPartySize() (+4 more)

### Community 92 - "Community 92"
Cohesion: 0.21
Nodes (10): buildReservationCalendarUrlsForAlerts(), formatReservationDateTimeLabel(), parseHistoryVisitDateIso(), parseReservationDateTime(), planGmailAlertDeliveryBatches(), resolveAlertStorePartitionKey(), resolveAlertTargetMonth(), isLikelyReservationNotificationMail() (+2 more)

### Community 93 - "Community 93"
Cohesion: 0.32
Nodes (11): AppError, buildSnippet(), CalendarSearchRow, clampLimit(), clampOffset(), fetchLineRoomCalendarSearchState(), fetchLineRoomMessageSearchState(), isRoomMessageSearchEnabled() (+3 more)

### Community 94 - "Community 94"
Cohesion: 0.18
Nodes (10): devDependencies, wrangler, name, private, scripts, deploy, dev, type (+2 more)

### Community 95 - "Community 95"
Cohesion: 0.33
Nodes (10): get, health(), infer_suffix(), ocr(), parse_confidence(), require_auth(), run_ndlocr(), Path (+2 more)

### Community 96 - "Community 96"
Cohesion: 0.20
Nodes (11): clampInt(), fetchGlobalSettings(), fetchLineUserPermissions(), fetchMonthlyPushUsageSummary(), fetchState(), getCurrentJstMonthUtcBounds(), isActionableDeliveryLogStatus(), isForceRunLogDetails() (+3 more)

### Community 97 - "Community 97"
Cohesion: 0.25
Nodes (11): buildDailySeriesForStoreMonth(), buildJstMonthRange(), dailyExportRowDiffersFromSheet(), formatSyncUpdatedAtForSheet(), mergeDailyExportRowsPreservingSheetEdits(), parseDailySheetDataRow(), parseNonNegativeInt(), parseSyncUpdatedAtToMs() (+3 more)

### Community 98 - "Community 98"
Cohesion: 0.36
Nodes (8): activeStorage(), buildEntryKey(), hashString(), normalizeEntryKey(), pruneStore(), readStore(), storageKey(), writeStore()

### Community 99 - "Community 99"
Cohesion: 0.22
Nodes (10): createSignedMediaUrl(), fetchLineMediaUsageStats(), fetchMediaCountByStore(), fetchMediaState(), fetchPettyCashReceiptMedia(), fetchSenderNameMapForUserIds(), fetchStoreMediaUsage(), formatLineMediaTag() (+2 more)

### Community 100 - "Community 100"
Cohesion: 0.44
Nodes (9): fetchManualMonthSales(), fetchManualMonthSalesMapForStore(), manualMonthSalesFromRow(), normalizeSheetIntegerInput(), parseManualMonthOperatingDays(), parseManualMonthPartyGuestFromUnknown(), parseOptionalNonNegativeInt(), parsePastSalesSheetRow() (+1 more)

### Community 101 - "Community 101"
Cohesion: 0.36
Nodes (7): extractLineMessageTextContent(), isLineRoomMessageRecordingEnabled(), LINE_ROOM_MESSAGE_RECORDING, LineMessageEvent, persistLineRoomMessageFromWebhook(), MEDIA_TYPES, persistLineRoomSearchArchivesFromWebhook()

### Community 103 - "Community 103"
Cohesion: 0.53
Nodes (8): apply_all_functions(), apply_budget_functions(), apply_sales_functions(), delete_budgets(), delete_sales(), seed_budgets(), seed_sales(), dummy-sales-seed.sh script

### Community 104 - "Community 104"
Cohesion: 0.33
Nodes (8): buildHardcodedHolidayMap(), fetchCaoHolidayMap(), fetchJapaneseHolidayMap(), HolidayLiveCache, JAPANESE_HOLIDAY_ISO_DATES, JapaneseHolidaySource, mergeWithFutureFallback(), parseCaoHolidayCsv()

### Community 105 - "Community 105"
Cohesion: 0.57
Nodes (7): buildReceiptDailyOverrideKey(), deleteReceiptDailyOverrides(), fetchReceiptDailyOverrideMap(), toNonNegativeInt(), toSafeOverrideStoreKey(), toSafeReceiptDate(), upsertReceiptDailyOverrides()

### Community 106 - "Community 106"
Cohesion: 0.29
Nodes (6): buildFoodCourtDistillationRecords(), FoodCourtDistillationRecord, UnknownRow, acceptedRows, iterations, runs

### Community 107 - "Community 107"
Cohesion: 0.25
Nodes (3): normalizePosJournalAiHistory(), normalizePosJournalAiQuestion(), expected

### Community 108 - "Community 108"
Cohesion: 0.29
Nodes (3): keepReceipts, key, STORE

### Community 109 - "Community 109"
Cohesion: 0.38
Nodes (7): buildCustomHeaderMap(), detectCsvDelimiter(), normalizeCsvHeaders(), normalizeHeaderLookupKey(), parseCsvLine(), parseCsvText(), parseExcelBuffer()

### Community 110 - "Community 110"
Cohesion: 0.52
Nodes (7): extractGoogleApiErrorMessage(), fetchGmailAccessTokenByRefreshToken(), fetchGmailLinkedAccountState(), fetchGmailProfile(), parseBooleanEnv(), parseJsonObjectSafe(), sanitizeSingleLine()

### Community 114 - "Community 114"
Cohesion: 0.43
Nodes (6): public.foodcourt_daily_facts, public.foodcourt_daily_features, public.forecast_predictions, public.sync_foodcourt_daily_facts(), public.tokyo_dome_events, trg_sync_foodcourt_daily_facts

### Community 115 - "Community 115"
Cohesion: 0.38
Nodes (5): foodcourt_ai_rag_from_feedback, foodcourt_ai_rag_from_run, public.foodcourt_ai_rag_documents, public.trg_sync_foodcourt_ai_rag_from_feedback(), public.trg_sync_foodcourt_ai_rag_from_run()

### Community 116 - "Community 116"
Cohesion: 0.29
Nodes (5): forbiddenTrackedEntries, ignoredLocalPatterns, localOnlyRootEntries, publicSiteFiles, root

### Community 117 - "Community 117"
Cohesion: 0.73
Nodes (5): apply(), current(), normalize(), set(), wire()

### Community 118 - "Community 118"
Cohesion: 0.33
Nodes (4): graph, migrations, missing, sources

### Community 119 - "Community 119"
Cohesion: 0.53
Nodes (5): countManual(), doPush, hocbnKey, main(), rest()

### Community 120 - "Community 120"
Cohesion: 0.40
Nodes (6): backupDatabaseTo(), asBackupTimestamp(), createBackup(), ensureBackupDirectory(), listBackupFiles(), pruneBackupFiles()

### Community 122 - "Community 122"
Cohesion: 0.40
Nodes (5): isJobTitleLabel(), JOB_TITLE_OPTIONS, jobTitleSortRank(), LABEL_SET, RANK_BY_LABEL

### Community 123 - "Community 123"
Cohesion: 0.40
Nodes (4): dependencies, exceptionLogging, runtimeVersion, timeZone

### Community 124 - "Community 124"
Cohesion: 0.70
Nodes (4): doLogout(), inject(), injectStyle(), resolveLogoutUrl()

### Community 125 - "Community 125"
Cohesion: 0.40
Nodes (4): isMarugoGroupStoreLabel(), LABEL_SET, MARUGO_GROUP_STORE_OPTIONS, STORE_COORDINATES

### Community 127 - "Community 127"
Cohesion: 0.40
Nodes (3): public.competitor_places, public.room_summary_settings, public.store_review_places

### Community 128 - "Community 128"
Cohesion: 0.50
Nodes (4): public.foodcourt_ai_feedback, public.foodcourt_ai_loop_runs, public.foodcourt_forecast_factors, public.foodcourt_forecast_history

### Community 130 - "Community 130"
Cohesion: 0.50
Nodes (3): KNOWLEDGE_VAULT_APP_DIR, KNOWLEDGE_VAULT_GRAPHIFY_DIR, update-knowledge-vault.sh script

### Community 132 - "Community 132"
Cohesion: 0.50
Nodes (3): public.line_sales_manual_month_gross, public.line_sales_month_budgets, public.line_sales_month_store_closed_days

### Community 134 - "Community 134"
Cohesion: 0.50
Nodes (3): public.ikyu_reservation_visit_events, public.manual_reservation_visit_events, public.tabelog_reservation_visit_events

### Community 136 - "Community 136"
Cohesion: 0.50
Nodes (3): public.receipt_sheets_past_sales_export_snapshot, public.security_rate_limits, public.store_webhook_tables

### Community 139 - "Community 139"
Cohesion: 0.83
Nodes (3): ikyu_hide_cancelled_reservation_event, public.hide_cancelled_partner_reservation_events(), tabelog_hide_cancelled_reservation_event

## Knowledge Gaps
- **587 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+582 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **126 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `xlsx` connect `Community 43` to `Community 68`, `Community 109`?**
  _High betweenness centrality (0.316) - this node is a cross-community bridge._
- **Why does `parseMonthlyDailySalesWorkbook()` connect `Community 68` to `Community 2`, `Community 43`, `Community 14`?**
  _High betweenness centrality (0.312) - this node is a cross-community bridge._
- **Why does `parseExcelBuffer()` connect `Community 109` to `Community 43`, `Community 3`?**
  _High betweenness centrality (0.307) - this node is a cross-community bridge._
- **Are the 24 inferred relationships involving `s()` (e.g. with `chart.umd.min.js` and `._updateHiddenIndices()`) actually correct?**
  _`s()` has 24 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _587 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.03414141414141414 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.022852376980817348 - nodes in this community are weakly interconnected._